import { Router, Request, Response } from 'express';
import axios from 'axios';
import { mlAuth } from '../auth/oauth';
import { currentUid, NoAccountContextError } from '../auth/context';
import { safeError } from '../security';
import { MLOrder, MLShipment, MLShipmentCosts } from '../types';
import { shippingPhase } from '../shipping-phase';

const router = Router();

/**
 * GET /api/summary?from=YYYY-MM-DD&to=YYYY-MM-DD[&prevFrom&prevTo][&tz=America/Mexico_City]
 *
 * Datos de la pantalla Inicio en UNA petición: órdenes del período (y del anterior, para los deltas) ya
 * reducidas a lo necesario (sin datos del comprador) y con el costo de envío resuelto con concurrencia
 * acotada. Los totales NO se calculan aquí: el frontend usa src/app/shared/order-math.ts, la misma
 * fórmula de Analytics, para que ambas pantallas den los mismos números.
 *
 * Presupuesto de tiempo (Vercel corta a los 10 s): si se agota, las órdenes sin costo de envío resuelto
 * van con `shipping: null` y la respuesta marca `partial: true`; nunca se rellenan con 0.
 */

const MAX_RANGE_DAYS = 92;          // período + período anterior caben en ~6 meses de órdenes
const MAX_SPAN_DAYS = 190;          // ventana total consultada (actual + anterior)
const MAX_ORDERS = 3000;            // tope de seguridad de órdenes por petición
const CHART_DAYS = 14;              // la gráfica de Inicio muestra los últimos 14 días
const TIME_BUDGET_MS = 8000;        // deja margen bajo el corte de 10 s de Vercel
const SHIP_CONCURRENCY = 5;
const MAX_RETRIES = 3;
export const DAY_MS = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FINAL_SHIPMENT_STATUS = new Set(['delivered', 'cancelled', 'not_delivered', 'returned']);

// ---------- Utilidades de fecha (zona horaria IANA, sin dependencias) ----------
export class BadRequest extends Error {}

export function parseDay(value: unknown, name: string): number {
    if (typeof value !== 'string' || !DATE_RE.test(value)) throw new BadRequest(`${name} debe ser una fecha YYYY-MM-DD`);
    const t = Date.parse(value + 'T00:00:00Z');
    if (isNaN(t) || new Date(t).toISOString().slice(0, 10) !== value) throw new BadRequest(`${name} no es una fecha válida`);
    return t; // medianoche UTC del día, solo para aritmética de días
}

export const dayStr = (utcMidnight: number): string => new Date(utcMidnight).toISOString().slice(0, 10);

export function validTimeZone(tz: unknown): string {
    if (tz === undefined || tz === '') return 'America/Mexico_City';
    if (typeof tz !== 'string' || tz.length > 64 || !/^[A-Za-z0-9_+\-\/]+$/.test(tz)) throw new BadRequest('tz inválida');
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { throw new BadRequest('tz inválida'); }
    return tz;
}

const dayFormatters = new Map<string, Intl.DateTimeFormat>();
function dayInTz(iso: string, tz: string): string {
    let f = dayFormatters.get(tz);
    if (!f) {
        f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
        dayFormatters.set(tz, f);
    }
    return f.format(new Date(iso)); // en-CA => YYYY-MM-DD
}

const hourFormatters = new Map<string, Intl.DateTimeFormat>();
function hourInTz(iso: string, tz: string): number {
    let f = hourFormatters.get(tz);
    if (!f) {
        f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', hour: '2-digit' });
        hourFormatters.set(tz, f);
    }
    return Number(f.format(new Date(iso))) % 24;
}

/** Instante UTC (ms) en que empieza `day` (YYYY-MM-DD) en la zona `tz`. */
export function startOfDayUtc(day: string, tz: string): number {
    const base = Date.parse(day + 'T00:00:00Z');
    let guess = base;
    for (let i = 0; i < 2; i++) {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit'
        }).formatToParts(new Date(guess));
        const g = (t: string) => Number(parts.find(p => p.type === t)?.value);
        const local = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'));
        guess = guess - (local - base);
    }
    return guess;
}

// ---------- Llamadas a ML con conteo, reintento en 429 y presupuesto ----------
export interface Ctx {
    token: string;
    deadline: number;
    mlCalls: number;
    cacheHits: number;
    retries: number;
}

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function mlGet<T>(ctx: Ctx, url: string, params?: Record<string, any>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
        ctx.mlCalls++;
        try {
            const res = await axios.get<T>(url, { headers: { Authorization: `Bearer ${ctx.token}` }, params, timeout: 6000 });
            return res.data;
        } catch (error: any) {
            const status = error?.response?.status;
            const retryable = status === 429 || status === 503;
            if (!retryable || attempt >= MAX_RETRIES) throw error;
            const retryAfter = Number(error.response?.headers?.['retry-after']);
            const wait = Math.min(isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 300 * 2 ** attempt, 2000);
            if (Date.now() + wait >= ctx.deadline) throw error; // sin tiempo para reintentar
            ctx.retries++;
            await sleep(wait);
        }
    }
}

// ---------- Caché de envíos (memoria del proceso) ----------
interface ShipInfo { cost: number; status: string; substatus: string | null; }
const shipCache = new Map<string, { v: ShipInfo; exp: number }>();
const SHIP_CACHE_MAX = 5000;

// Claves `uid:id`: el envío de una cuenta nunca se sirve a otra
const shipKey = (id: string) => `${currentUid()}:${id}`;

function cacheShip(id: string, v: ShipInfo): void {
    // Entregado/cancelado ya no cambia: se guarda mucho más tiempo que uno en tránsito
    const ttl = FINAL_SHIPMENT_STATUS.has(v.status) ? 6 * 3600_000 : 2 * 60_000;
    if (shipCache.size >= SHIP_CACHE_MAX) shipCache.delete(shipCache.keys().next().value as string);
    shipCache.set(shipKey(id), { v, exp: Date.now() + ttl });
}

/** Costo que paga el vendedor (misma regla que GET /api/shipments/:id). null si no se pudo resolver. */
async function shipmentInfo(ctx: Ctx, id: string): Promise<ShipInfo | null> {
    const hit = shipCache.get(shipKey(id));
    if (hit && hit.exp > Date.now()) { ctx.cacheHits++; return hit.v; }
    try {
        const shipment = await mlGet<MLShipment>(ctx, `https://api.mercadolibre.com/shipments/${encodeURIComponent(id)}`);
        let sellerCost: number | null = null;
        try {
            const costs = await mlGet<MLShipmentCosts>(ctx, `https://api.mercadolibre.com/shipments/${encodeURIComponent(id)}/costs`);
            const senders = costs.senders || [];
            if (senders.length) sellerCost = senders.reduce((sum, s) => sum + (s.cost || 0), 0);
        } catch (costError: any) {
            // Si /costs falla por límite o red NO se adivina: la regla de respaldo (list_cost del envío)
            // solo se usa cuando ML responde que /costs no aplica (4xx distinto de 429)
            const status = costError?.response?.status;
            if (!(status && status >= 400 && status < 500 && status !== 429)) return null;
        }
        const cost = sellerCost ?? shipment.shipping_option?.list_cost ?? shipment.list_cost ?? 0;
        const info = { cost, status: shipment.status, substatus: shipment.substatus ?? null };
        cacheShip(id, info);
        return info;
    } catch (error) {
        console.warn(`summary: envío ${id} no disponible: ${safeError(error)}`);
        return null;
    }
}

export async function runPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>, deadline: number): Promise<void> {
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            if (Date.now() >= deadline) return; // lo que no se alcanzó queda sin resolver (null)
            await fn(items[next++]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// ---------- Órdenes ----------
export async function fetchOrders(ctx: Ctx, fromIso: string, toIso: string, includeUnfulfilled = false): Promise<{ orders: MLOrder[]; truncated: boolean }> {
    const me = await mlGet<{ id: number }>(ctx, 'https://api.mercadolibre.com/users/me');
    const orders: MLOrder[] = [];
    let offset = 0;
    let truncated = false;
    for (;;) {
        const page: any = await mlGet(ctx, 'https://api.mercadolibre.com/orders/search', {
            seller: me.id, sort: 'date_desc', limit: 50, offset,
            'order.date_created.from': fromIso, 'order.date_created.to': toIso
        });
        const results: MLOrder[] = page.results || [];
        orders.push(...results);
        const paging = page.paging;
        offset += paging?.limit || 50;
        if (!paging || results.length === 0 || offset >= paging.total) break;
        if (orders.length >= MAX_ORDERS || Date.now() > ctx.deadline - 2000) { truncated = true; break; }
    }
    // Por defecto se excluyen las órdenes con fulfilled === false (canceladas); Analytics puede pedir incluirlas
    return { orders: includeUnfulfilled ? orders : orders.filter(o => (o as any).fulfilled !== false), truncated };
}

// Resultado completo cacheado unos segundos (cambiar de pestaña y volver no repite todo)
const responseCache = new Map<string, { exp: number; body: any }>();
const RESPONSE_TTL_MS = 30_000;

router.get('/', async (req: Request, res: Response) => {
    const started = Date.now();
    try {
        const fromT = parseDay(req.query['from'], 'from');
        const toT = parseDay(req.query['to'], 'to');
        if (fromT > toT) throw new BadRequest('from no puede ser posterior a to');
        const days = (toT - fromT) / DAY_MS + 1;
        if (days > MAX_RANGE_DAYS) throw new BadRequest(`El rango máximo es de ${MAX_RANGE_DAYS} días`);
        if (toT > Date.now() + 2 * DAY_MS) throw new BadRequest('to no puede estar en el futuro');

        // Período anterior: explícito o de igual duración inmediatamente antes
        const hasPrev = req.query['prevFrom'] !== undefined || req.query['prevTo'] !== undefined;
        const prevToT = hasPrev ? parseDay(req.query['prevTo'], 'prevTo') : fromT - DAY_MS;
        const prevFromT = hasPrev ? parseDay(req.query['prevFrom'], 'prevFrom') : prevToT - (days - 1) * DAY_MS;
        if (prevFromT > prevToT) throw new BadRequest('prevFrom no puede ser posterior a prevTo');
        const tz = validTimeZone(req.query['tz']);

        const chartFromT = toT - (CHART_DAYS - 1) * DAY_MS;
        const windowFromT = Math.min(prevFromT, chartFromT, fromT);
        if ((toT - windowFromT) / DAY_MS > MAX_SPAN_DAYS) throw new BadRequest('La ventana consultada es demasiado grande');

        const includeUnfulfilled = req.query['includeUnfulfilled'] === '1';
        const key = [currentUid(), dayStr(fromT), dayStr(toT), dayStr(prevFromT), dayStr(prevToT), tz, includeUnfulfilled ? 'all' : 'ok'].join('|');
        const cached = responseCache.get(key);
        if (cached && cached.exp > Date.now()) {
            return res.json({ ...cached.body, meta: { ...cached.body.meta, ms: Date.now() - started, mlCalls: 0, responseCache: true } });
        }

        const token = await mlAuth.getToken();
        const ctx: Ctx = { token, deadline: started + TIME_BUDGET_MS, mlCalls: 0, cacheHits: 0, retries: 0 };

        const fromIso = new Date(startOfDayUtc(dayStr(windowFromT), tz)).toISOString();
        const toIso = new Date(startOfDayUtc(dayStr(toT + DAY_MS), tz) - 1).toISOString();
        const { orders, truncated } = await fetchOrders(ctx, fromIso, toIso, includeUnfulfilled);

        const dFrom = dayStr(fromT), dTo = dayStr(toT), dChart = dayStr(chartFromT);
        const rows = orders.map(o => ({
            id: o.id,
            day: dayInTz(o.date_created, tz),
            hour: hourInTz(o.date_created, tz),
            total_amount: o.total_amount,
            order_items: o.order_items.map(i => ({
                id: i.item.id, title: i.item.title, quantity: i.quantity, sale_fee: i.sale_fee, unit_price: i.unit_price
            })),
            shipId: o.shipping?.id ? String(o.shipping.id) : null,
            listCost: null as number | null,
        }));

        // Prioridad: lo que se ve en KPIs y gráfica primero; el período anterior al final
        const priority = (d: string) => (d >= dFrom && d <= dTo) || (d >= dChart && d <= dTo) ? 0 : 1;
        const pending = rows.filter(r => r.shipId !== null).sort((a, b) => priority(a.day) - priority(b.day));
        // Sin envío asociado (p. ej. entrega acordada): no hay costo que consultar, igual que en Analytics
        rows.filter(r => r.shipId === null).forEach(r => { r.listCost = 0; });

        await runPool(pending, SHIP_CONCURRENCY, async r => {
            const info = await shipmentInfo(ctx, r.shipId as string);
            if (info) r.listCost = info.cost;
        }, ctx.deadline);

        const missing = rows.filter(r => r.listCost === null).length;
        const body = {
            range: { from: dFrom, to: dTo, prevFrom: dayStr(prevFromT), prevTo: dayStr(prevToT), chartFrom: dChart, tz },
            orders: rows.map(({ shipId, ...r }) => r),
            partial: missing > 0 || truncated,
            shippingMissing: missing,
            truncated,
            meta: { ms: Date.now() - started, mlCalls: ctx.mlCalls, shipmentCacheHits: ctx.cacheHits, retries: ctx.retries, orders: rows.length }
        };
        // Solo se cachea el resultado completo: uno parcial se reintenta en la siguiente petición
        if (!body.partial) responseCache.set(key, { exp: Date.now() + RESPONSE_TTL_MS, body });
        res.json(body);
    } catch (error: any) {
        if (error instanceof BadRequest) return res.status(400).json({ error: 'Invalid parameter', message: error.message });
        console.error('Error building summary:', safeError(error));
        if (error instanceof NoAccountContextError || error?.message?.includes('No token available')) {
            return res.status(401).json({ error: 'Not authorized', message: 'Please authorize the app first by visiting /auth' });
        }
        res.status(500).json({ error: 'Failed to build summary' });
    }
});

/**
 * GET /api/summary/pending
 * Órdenes (últimos 30 días, no canceladas) cuyo envío aún no sale ("Por enviar" en Mercado Libre).
 * Alimenta la insignia de "Órdenes" en la barra lateral.
 */
const pendingCache = new Map<string, { exp: number; body: any }>(); // por uid
router.get('/pending', async (_req: Request, res: Response) => {
    const started = Date.now();
    try {
        const uid = currentUid();
        const pendingHit = pendingCache.get(uid);
        if (pendingHit && pendingHit.exp > Date.now()) return res.json(pendingHit.body);
        const token = await mlAuth.getToken();
        const ctx: Ctx = { token, deadline: started + TIME_BUDGET_MS, mlCalls: 0, cacheHits: 0, retries: 0 };
        const tz = 'America/Mexico_City';
        const today = Date.parse(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
        const fromIso = new Date(startOfDayUtc(dayStr(today - 30 * DAY_MS), tz)).toISOString();
        const toIso = new Date(Date.now() + DAY_MS).toISOString();
        const { orders } = await fetchOrders(ctx, fromIso, toIso);
        const candidates = orders.filter(o => o.status !== 'cancelled' && !(o as any).tags?.includes('delivered') && o.shipping?.id);
        let count = 0, unknown = 0;
        await runPool(candidates, SHIP_CONCURRENCY, async o => {
            const info = await shipmentInfo(ctx, String(o.shipping.id));
            if (!info) unknown++;
            else if (shippingPhase(info.status, info.substatus) === 'to_ship') count++; // ya dejado en la agencia no cuenta
        }, ctx.deadline);
        const body = { count, partial: unknown > 0, meta: { ms: Date.now() - started, mlCalls: ctx.mlCalls } };
        if (!body.partial) pendingCache.set(uid, { exp: Date.now() + 60_000, body });
        res.json(body);
    } catch (error: any) {
        console.error('Error counting pending shipments:', safeError(error));
        if (error instanceof NoAccountContextError) return res.status(401).json({ error: 'Not authorized' });
        res.status(500).json({ error: 'Failed to count pending shipments' });
    }
});

export default router;
