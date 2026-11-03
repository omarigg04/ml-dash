import { Router, Request, Response } from 'express';
import { mlAuth } from '../auth/oauth';
import { currentUid, NoAccountContextError } from '../auth/context';
import { ITEM_ID_RE, safeError } from '../security';
import { BadRequest, Ctx, DAY_MS, mlGet, parseDay, dayStr, runPool } from './summary';

const router = Router();

/**
 * GET /api/analytics/items?from=YYYY-MM-DD&to=YYYY-MM-DD[&ids=MLM1,MLM2]
 *
 * Datos de publicaciones + visitas para Analytics (conversión real y tips). SOLO LECTURA.
 *  - Publicaciones activas del vendedor + las `ids` pedidas (las vendidas en la ventana, aunque ya no estén activas).
 *  - Visitas por día de cada una (GET /items/{id}/visits/time_window), sumadas dentro de [from, to] y en los últimos 30 días.
 *  - Visitas por día de toda la cuenta en [from, to].
 *
 * Por qué no sold_quantity / visitas: sold_quantity es de toda la vida pero ML no conserva todo el historial de
 * visitas, así que ese cociente da porcentajes imposibles. La conversión real usa órdenes y visitas DE LA MISMA ventana.
 *
 * Mismo enfoque de presupuesto que summary.ts: concurrencia acotada y, si se agota el tiempo, las publicaciones sin
 * visitas resueltas van con `visits: null` y la respuesta marca `partial: true`. Nunca se rellenan con 0.
 */

const ML_API = 'https://api.mercadolibre.com';
const MAX_WINDOW_DAYS = 150;        // ML rechaza `last` > 150 días
const MAX_ITEMS = 250;              // tope de publicaciones a las que se consultan visitas
const TIME_BUDGET_MS = 8000;
const VISITS_CONCURRENCY = 10;
const DETAIL_BATCH = 20;
const VISITS_TTL_MS = 10 * 60_000;
const RESPONSE_TTL_MS = 30_000;

interface DayCount { date: string; total: number; }
const visitsCache = new Map<string, { exp: number; days: DayCount[]; last: number }>();
const responseCache = new Map<string, { exp: number; body: any }>();

const todayInTz = (): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

/** Visitas por día de una publicación en los últimos `last` días (ML: puede devolver last+1 con hoy y omite días sin datos). */
async function itemDaily(ctx: Ctx, id: string, last: number): Promise<DayCount[] | null> {
    const vKey = `${currentUid()}:${id}`; // por cuenta
    const hit = visitsCache.get(vKey);
    if (hit && hit.exp > Date.now() && hit.last >= last) { ctx.cacheHits++; return hit.days; }
    try {
        const data: any = await mlGet(ctx, `${ML_API}/items/${encodeURIComponent(id)}/visits/time_window`, { last, unit: 'day' });
        const days: DayCount[] = (Array.isArray(data?.results) ? data.results : [])
            .map((x: any) => ({ date: String(x.date).slice(0, 10), total: Number(x.total) || 0 }));
        visitsCache.set(vKey, { exp: Date.now() + VISITS_TTL_MS, days, last });
        return days;
    } catch (error) {
        console.warn(`analytics: visitas de ${id} no disponibles: ${safeError(error)}`);
        return null;
    }
}

const sumRange = (days: DayCount[], a: string, b: string): number =>
    days.reduce((acc, d) => (d.date >= a && d.date <= b ? acc + d.total : acc), 0);

router.get('/items', async (req: Request, res: Response) => {
    const started = Date.now();
    try {
        const fromT = parseDay(req.query['from'], 'from');
        const toT = parseDay(req.query['to'], 'to');
        if (fromT > toT) throw new BadRequest('from no puede ser posterior a to');
        const today = todayInTz();
        const todayT = Date.parse(today + 'T00:00:00Z');
        if (toT > todayT + DAY_MS) throw new BadRequest('to no puede estar en el futuro');
        const last = Math.round((todayT - fromT) / DAY_MS) + 1;
        if (last > MAX_WINDOW_DAYS) throw new BadRequest(`from no puede ser anterior a ${MAX_WINDOW_DAYS} días atrás (límite de ML)`);

        const rawIds = typeof req.query['ids'] === 'string' ? (req.query['ids'] as string).split(',').map(s => s.trim()).filter(Boolean) : [];
        if (rawIds.some(i => !ITEM_ID_RE.test(i))) throw new BadRequest('ids contiene un id inválido');
        if (rawIds.length > MAX_ITEMS) throw new BadRequest(`Máximo ${MAX_ITEMS} ids`);

        const dFrom = dayStr(fromT), dTo = dayStr(toT);
        const last30From = dayStr(todayT - 29 * DAY_MS);
        const key = [currentUid(), dFrom, dTo, [...new Set(rawIds)].sort().join(',')].join('|');
        const cached = responseCache.get(key);
        if (cached && cached.exp > Date.now()) {
            return res.json({ ...cached.body, meta: { ...cached.body.meta, ms: Date.now() - started, mlCalls: 0, responseCache: true } });
        }

        const token = await mlAuth.getToken();
        const ctx: Ctx = { token, deadline: started + TIME_BUDGET_MS, mlCalls: 0, cacheHits: 0, retries: 0 };

        const me = await mlGet<{ id: number }>(ctx, `${ML_API}/users/me`);

        // 1) Ids: activas + pedidas
        const ids = new Set<string>(rawIds);
        for (let offset = 0; offset < 300; offset += 100) {
            const page: any = await mlGet(ctx, `${ML_API}/users/${me.id}/items/search`, { status: 'active', limit: 100, offset });
            (page.results || []).forEach((i: string) => ids.add(i));
            if (!page.paging || offset + 100 >= page.paging.total) break;
        }
        const idList = [...ids].slice(0, MAX_ITEMS);
        const truncated = ids.size > MAX_ITEMS;

        // 2) Detalle (multiget de 20)
        const batches: string[][] = [];
        for (let i = 0; i < idList.length; i += DETAIL_BATCH) batches.push(idList.slice(i, i + DETAIL_BATCH));
        const items: any[] = [];
        await runPool(batches, 4, async batch => {
            const rows: any[] = await mlGet(ctx, `${ML_API}/items`, { ids: batch.join(',') });
            rows.filter(r => r.code === 200).forEach(r => {
                const b = r.body;
                items.push({
                    id: b.id, title: b.title, price: b.price, available_quantity: b.available_quantity,
                    sold_quantity: b.sold_quantity || 0, status: b.status, listing_type_id: b.listing_type_id,
                    permalink: b.permalink, date_created: b.date_created || null, free_shipping: !!b.shipping?.free_shipping,
                    visits: null as number | null, visits30: null as number | null
                });
            });
        }, ctx.deadline);

        // 3) Visitas por publicación (concurrencia acotada, presupuesto de tiempo)
        await runPool(items, VISITS_CONCURRENCY, async it => {
            const days = await itemDaily(ctx, it.id, last);
            if (days) { it.visits = sumRange(days, dFrom, dTo); it.visits30 = sumRange(days, last30From, today); }
        }, ctx.deadline);

        // 4) Visitas diarias de la cuenta en la ventana (ML omite los días sin datos: se reportan tal cual)
        let account: DayCount[] | null = null;
        try {
            const r: any = await mlGet(ctx, `${ML_API}/users/${me.id}/items_visits/time_window`, { last, unit: 'day' });
            account = (Array.isArray(r?.results) ? r.results : [])
                .map((x: any) => ({ date: String(x.date).slice(0, 10), total: Number(x.total) || 0 }))
                .filter((x: DayCount) => x.date >= dFrom && x.date <= dTo)
                .sort((a: DayCount, b: DayCount) => a.date.localeCompare(b.date));
        } catch (error) {
            console.warn(`analytics: visitas de la cuenta no disponibles: ${safeError(error)}`);
        }

        const missing = items.filter(i => i.visits === null).length;
        const body = {
            range: { from: dFrom, to: dTo, last30From, today },
            items,
            accountDaily: account,
            partial: missing > 0 || account === null || truncated,
            visitsMissing: missing,
            truncated,
            meta: { ms: Date.now() - started, mlCalls: ctx.mlCalls, cacheHits: ctx.cacheHits, retries: ctx.retries, items: items.length }
        };
        if (!body.partial) responseCache.set(key, { exp: Date.now() + RESPONSE_TTL_MS, body });
        res.json(body);
    } catch (error: any) {
        if (error instanceof BadRequest) return res.status(400).json({ error: 'Invalid parameter', message: error.message });
        console.error('Error building analytics items:', safeError(error));
        if (error instanceof NoAccountContextError || error?.message?.includes('No token available')) {
            return res.status(401).json({ error: 'Not authorized', message: 'Please authorize the app first by visiting /auth' });
        }
        res.status(500).json({ error: 'Failed to build analytics' });
    }
});

export default router;
