import { Router, Request, Response } from 'express';
import axios from 'axios';
import { mlAuth } from '../auth/oauth';
import { currentUid, NoAccountContextError } from '../auth/context';
import { ITEM_ID_RE, safeError } from '../security';
import { BadRequest, Ctx, DAY_MS, dayStr, fetchOrders, mlGet, startOfDayUtc } from './summary';
import { AnalyticsItem, itemDaily, loadItemsWithVisits, sumRange, todayInTz } from './analytics';
import { AiError, AiUsage, aiKeyConfigured, callStructured } from '../ai/claude';
import { StoreUnavailableError, storeCount, storeDecr, storeGet, storeIncr, storeSet } from '../ai/kvstore';
import {
    FLAG_TEXT, IdeasSchema, MAX_IDEAS, MAX_TITLES, SuggestSchema,
    IdeasOut, SuggestOut, descriptionFlags, filterTitles, isCosmeticCopy
} from '../ai/rules';
import {
    IdeaSource, PromptContrast, SYSTEM_PROMPT, buildIdeasPrompt, buildSuggestPrompt, pickAttributes
} from '../ai/prompts';

const router = Router();
const ML_API = 'https://api.mercadolibre.com';

/**
 * Oportunidades: publicaciones con visitas que no venden + sugerencias de Claude (bajo demanda).
 * La app NUNCA publica ni cambia nada por sí sola: solo lee de ML y guarda en KV (caché, contador, cambios aplicados).
 */

// ---------------- Constantes ----------------
export const WINDOW_DAYS = 90;
/**
 * Mismos umbrales que la regla "Reciben visitas pero casi no venden" de Analytics
 * (TIP_THRESHOLDS.highVisits en src/app/analytics/tips.ts). Una prueba comprueba que sigan iguales.
 */
export const CANDIDATE_THRESHOLDS = { minVisits: 60, maxConversion: 0.01 } as const;
const MAX_CANDIDATES = 20;
const BEST_SELLERS = 5;
const IDEA_SOURCES = 8;
const CONTRAST_COUNT = 3;
const TIME_BUDGET_MS = 25_000;
const STORE_TTL_MS = 2 * 60_000;
const CACHE_TTL_S = 7 * 24 * 3600;
const USAGE_TTL_S = 2 * 24 * 3600;
export const MIN_DAYS_FOR_RESULTS = 14;
export const MIN_VISITS_FOR_RESULTS = 30;
const MAX_APPLIED = 100;
const APPLIED_LIST = 30;

export const dailyLimit = (): number => {
    const n = Number.parseInt(process.env['AI_DAILY_LIMIT'] ?? '', 10);
    return Number.isFinite(n) && n > 0 ? n : 20;
};

// ---------------- Claves KV (todas incluyen el uid) ----------------
const usageKey = (uid: string) => `ai_usage:${uid}:${todayInTz()}`;
const suggestKey = (uid: string, itemId: string) => `ai_suggest:${uid}:${itemId}`;
const ideasKey = (uid: string) => `ai_ideas:${uid}`;
const changeKey = (uid: string, itemId: string, ts: number) => `ai_change:${uid}:${itemId}:${ts}`;
const changeIndexKey = (uid: string) => `ai_change_idx:${uid}`;

// ---------------- Utilidades ----------------
const diffDays = (a: string, b: string): number => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY_MS);
const addDays = (day: string, n: number): string => new Date(Date.parse(day + 'T00:00:00Z') + n * DAY_MS).toISOString().slice(0, 10);
const round1 = (n: number): number => Math.round(n * 10) / 10;
const round2 = (n: number): number => Math.round(n * 100) / 100;
const pct = (orders: number, visits: number): number => (visits > 0 ? round2((orders / visits) * 100) : 0);
const TZ = 'America/Mexico_City';

async function newCtx(): Promise<Ctx> {
    return { token: await mlAuth.getToken(), deadline: Date.now() + TIME_BUDGET_MS, mlCalls: 0, cacheHits: 0, retries: 0 };
}

async function usageSnapshot(uid: string): Promise<{ used: number; limit: number; remaining: number }> {
    const limit = dailyLimit();
    const used = await storeCount(usageKey(uid));
    return { used, limit, remaining: Math.max(0, limit - used) };
}

/** Reserva un uso con INCR atómico; si ya se llegó al tope, lo devuelve y rechaza (429). */
async function reserveUse(uid: string): Promise<void> {
    const limit = dailyLimit();
    const n = await storeIncr(usageKey(uid), USAGE_TTL_S);
    if (n > limit) {
        await storeDecr(usageKey(uid)).catch(() => undefined);
        throw new AiError(429, 'AI_DAILY_LIMIT', `Llegaste al límite de ${limit} generaciones de hoy. Se reinicia mañana; mientras tanto puedes ver los resultados guardados.`);
    }
}
const refundUse = (uid: string) => storeDecr(usageKey(uid)).catch(() => undefined);
/** Errores en los que Claude ya procesó la solicitud (cuesta dinero): no se devuelve el uso. */
const BILLED_CODES = new Set(['AI_REFUSAL', 'AI_TRUNCATED', 'AI_INVALID_OUTPUT']);

function sendError(res: Response, error: any, what: string): void {
    if (error instanceof AiError) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
    if (error instanceof StoreUnavailableError) {
        console.error(`opportunities ${what}: KV no disponible: ${error.message}`);
        res.status(503).json({ error: 'No se pudo verificar el límite de uso (almacenamiento no disponible). Intenta más tarde.', code: 'STORE_UNAVAILABLE' });
        return;
    }
    if (error instanceof BadRequest) { res.status(400).json({ error: error.message, code: 'BAD_REQUEST' }); return; }
    if (error instanceof NoAccountContextError || error?.message?.includes('No token available')) {
        res.status(401).json({ error: 'Not authorized', code: 'SESSION_REQUIRED', message: 'Please authorize the app first by visiting /auth' });
        return;
    }
    const st = error?.response?.status;
    console.error(`opportunities ${what}:`, safeError(error));
    if (st === 404) { res.status(404).json({ error: 'No se encontró la publicación en Mercado Libre.', code: 'ITEM_NOT_FOUND' }); return; }
    if (st === 403) { res.status(403).json({ error: 'Mercado Libre no permite leer esa publicación con esta cuenta.', code: 'NOT_YOUR_ITEM' }); return; }
    res.status(500).json({ error: 'No se pudo completar la operación.', code: 'INTERNAL' });
}

const requireAi = (): void => {
    if (!aiKeyConfigured()) throw new AiError(503, 'AI_NOT_CONFIGURED', 'Falta configurar la clave de Claude (ANTHROPIC_API_KEY) en el servidor. El resto de la página sigue funcionando.');
};

const parseItemId = (v: unknown): string => {
    if (typeof v !== 'string' || !ITEM_ID_RE.test(v)) throw new BadRequest('itemId inválido');
    return v;
};

/** Lee la publicación fresca y exige que sea de la cuenta actual ANTES de cualquier otra cosa. */
async function readOwnItem(ctx: Ctx, uid: string, itemId: string): Promise<any> {
    const item: any = await mlGet(ctx, `${ML_API}/items/${encodeURIComponent(itemId)}`);
    if (!item || String(item.seller_id) !== uid) {
        throw new AiError(403, 'NOT_YOUR_ITEM', 'Esa publicación no pertenece a la cuenta actual.');
    }
    return item;
}

async function readDescription(ctx: Ctx, itemId: string): Promise<string> {
    try {
        const d: any = await mlGet(ctx, `${ML_API}/items/${encodeURIComponent(itemId)}/description`);
        return String(d?.plain_text ?? d?.text ?? '');
    } catch (e: any) {
        if (e?.response?.status === 404) return '';
        throw e;
    }
}

// ---------------- Datos de la tienda (ventana de 90 días) ----------------
interface ItemAgg { id: string; title: string; orders: number; units: number; }
interface StoreData {
    from: string; to: string;
    items: AnalyticsItem[]; itemsTruncated: boolean;
    agg: Map<string, ItemAgg>; ordersTruncated: boolean;
}
const storeCache = new Map<string, { exp: number; data: StoreData }>(); // clave = uid

function aggregateOrders(orders: any[]): Map<string, ItemAgg> {
    const agg = new Map<string, ItemAgg>();
    for (const o of orders) {
        if (o?.status === 'cancelled') continue;
        const seen = new Set<string>();
        for (const li of o?.order_items || []) {
            const id = String(li?.item?.id ?? '');
            if (!id) continue;
            const a = agg.get(id) ?? { id, title: String(li.item?.title ?? ''), orders: 0, units: 0 };
            a.units += Number(li.quantity) || 0;
            if (!seen.has(id)) { a.orders++; seen.add(id); }
            agg.set(id, a);
        }
    }
    return agg;
}

async function loadStore(ctx: Ctx, uid: string): Promise<StoreData> {
    const hit = storeCache.get(uid);
    if (hit && hit.exp > Date.now()) return hit.data;
    const today = todayInTz();
    const todayT = Date.parse(today + 'T00:00:00Z');
    const from = dayStr(todayT - (WINDOW_DAYS - 1) * DAY_MS);
    const last30From = dayStr(todayT - 29 * DAY_MS);
    const me = await mlGet<{ id: number }>(ctx, `${ML_API}/users/me`);
    const { items, truncated } = await loadItemsWithVisits(ctx, me.id, [], WINDOW_DAYS, from, today, last30From, today);
    const fromIso = new Date(startOfDayUtc(from, TZ)).toISOString();
    const toIso = new Date(startOfDayUtc(dayStr(todayT + DAY_MS), TZ) - 1).toISOString();
    const { orders, truncated: ordersTruncated } = await fetchOrders(ctx, fromIso, toIso);
    const data: StoreData = { from, to: today, items, itemsTruncated: truncated, agg: aggregateOrders(orders), ordersTruncated };
    const complete = !ordersTruncated && !truncated && items.every(i => i.visits !== null);
    if (complete) storeCache.set(uid, { exp: Date.now() + STORE_TTL_MS, data });
    return data;
}

const conversion = (orders: number, visits: number): number => (visits > 0 ? orders / visits : 0);

// ---------------- GET /candidates ----------------
router.get('/candidates', async (_req: Request, res: Response) => {
    try {
        const uid = currentUid();
        const ctx = await newCtx();
        const store = await loadStore(ctx, uid);
        const T = CANDIDATE_THRESHOLDS;
        const partial = store.ordersTruncated || store.itemsTruncated || store.items.some(i => i.visits === null);

        // Con órdenes incompletas la conversión saldría artificialmente baja: no se ofrecen candidatos
        const improve = store.ordersTruncated ? [] : store.items
            .filter(i => i.status === 'active' && i.visits !== null && i.visits >= T.minVisits)
            .map(i => {
                const a = store.agg.get(i.id);
                const orders = a?.orders ?? 0;
                return { i, orders, units: a?.units ?? 0, visits: i.visits as number };
            })
            .filter(r => conversion(r.orders, r.visits) < T.maxConversion)
            .sort((a, b) => b.visits - a.visits)
            .slice(0, MAX_CANDIDATES)
            .map(r => ({
                id: r.i.id, title: r.i.title, price: r.i.price, listing_type_id: r.i.listing_type_id, permalink: r.i.permalink,
                visits: r.visits, orders: r.orders, units: r.units, conversionPct: pct(r.orders, r.visits),
            }));

        const visitsOf = new Map(store.items.map(i => [i.id, i.visits]));
        const bestSellers = [...store.agg.values()]
            .filter(a => a.units > 0)
            .sort((a, b) => b.units - a.units || b.orders - a.orders)
            .slice(0, BEST_SELLERS)
            .map(a => ({ id: a.id, title: a.title, orders: a.orders, units: a.units, visits: visitsOf.get(a.id) ?? null }));

        let usage = null as null | { used: number; limit: number; remaining: number };
        try { usage = await usageSnapshot(uid); } catch (e) { if (!(e instanceof StoreUnavailableError)) throw e; }

        res.json({
            window: { days: WINDOW_DAYS, from: store.from, to: store.to },
            thresholds: { minVisits: T.minVisits, maxConversionPct: T.maxConversion * 100 },
            improve, bestSellers,
            partial, ordersTruncated: store.ordersTruncated,
            ai: { configured: aiKeyConfigured(), usage },
        });
    } catch (error) {
        sendError(res, error, 'candidates');
    }
});

// ---------------- POST /suggest ----------------
router.post('/suggest', async (req: Request, res: Response) => {
    try {
        const uid = currentUid();
        const itemId = parseItemId(req.body?.itemId);
        const regenerate = req.body?.regenerate === true;
        requireAi();

        const ctx = await newCtx();
        const item = await readOwnItem(ctx, uid, itemId); // antes de cualquier llamada a Claude
        if (!['active', 'paused'].includes(item.status)) {
            throw new AiError(409, 'ITEM_NOT_SUGGESTABLE', `La publicación está en estado "${item.status}"; solo se sugieren mejoras para activas o pausadas.`);
        }

        if (!regenerate) {
            const cached = await storeGet<any>(suggestKey(uid, itemId));
            if (cached) { res.json({ ...cached, cached: true, usage: await usageSnapshot(uid) }); return; }
        }

        const [description, store] = await Promise.all([readDescription(ctx, itemId), loadStore(ctx, uid)]);
        let visits = store.items.find(i => i.id === itemId)?.visits ?? null;
        if (visits === null) {
            const days = await itemDaily(ctx, itemId, WINDOW_DAYS);
            visits = days ? sumRange(days, store.from, store.to) : null;
        }
        if (visits === null || store.ordersTruncated) {
            throw new AiError(503, 'METRICS_UNAVAILABLE', 'No se pudieron leer completas las visitas u órdenes de Mercado Libre. Intenta de nuevo en un momento.');
        }
        const agg = store.agg.get(itemId);
        const metrics = { windowDays: WINDOW_DAYS, visits, orders: agg?.orders ?? 0, units: agg?.units ?? 0, conversionPct: pct(agg?.orders ?? 0, visits) };

        const contrast: PromptContrast[] = store.items
            .filter(i => i.id !== itemId && i.status === 'active' && i.visits !== null && i.visits > 0 && (store.agg.get(i.id)?.orders ?? 0) > 0)
            .map(i => ({ i, o: store.agg.get(i.id)!.orders, v: i.visits as number }))
            .sort((a, b) => conversion(b.o, b.v) - conversion(a.o, a.v))
            .slice(0, CONTRAST_COUNT)
            .map(r => ({ title: r.i.title, price: r.i.price, visits: r.v, orders: r.o, conversionPct: pct(r.o, r.v) }));

        const prompt = buildSuggestPrompt({
            id: item.id, title: item.title, price: item.price ?? null, listing_type_id: item.listing_type_id,
            condition: item.condition, free_shipping: !!item.shipping?.free_shipping,
            attributes: pickAttributes(item.attributes), description,
        }, metrics, contrast);

        await reserveUse(uid);
        let out: { data: SuggestOut; usage: AiUsage };
        try {
            out = await callStructured('suggest', SuggestSchema, SYSTEM_PROMPT, prompt);
        } catch (e) {
            if (!(e instanceof AiError && BILLED_CODES.has(e.code))) await refundUse(uid);
            throw e;
        }

        const { kept, dropped } = filterTitles(out.data.titles);
        const warnings: string[] = [];
        if (dropped.length) warnings.push(`Se descartaron ${dropped.length} título(s) por pasar de 60 caracteres, traer datos de contacto o promesas no permitidas.`);
        if (kept.length === 0) warnings.push('Ningún título cumplió las reglas. Prueba "Regenerar".');
        const titles = kept.slice(0, MAX_TITLES).map(t => ({ title: t.title, reason: String(t.reason ?? ''), length: t.title.length }));
        const flags = descriptionFlags(out.data.description.text);
        if (flags.length) warnings.push(`La descripción propuesta ${flags.map(f => FLAG_TEXT[f]).join(', ')}. Corrígela antes de aplicarla.`);

        const body = {
            itemId, generatedAt: new Date().toISOString(),
            metrics,
            current: { title: String(item.title), description, price: item.price ?? null },
            titles, droppedTitles: dropped.length,
            description: { text: out.data.description.text, reason: out.data.description.reason, flags: flags.map(f => ({ code: f, text: FLAG_TEXT[f] })) },
            checks: out.data.checks.map(String).filter(Boolean),
            warnings,
        };
        await storeSet(suggestKey(uid, itemId), body, CACHE_TTL_S);
        res.json({ ...body, cached: false, usage: await usageSnapshot(uid) });
    } catch (error) {
        sendError(res, error, 'suggest');
    }
});

// ---------------- POST /ideas ----------------
router.post('/ideas', async (req: Request, res: Response) => {
    try {
        const uid = currentUid();
        const regenerate = req.body?.regenerate === true;
        requireAi();

        if (!regenerate) {
            const cached = await storeGet<any>(ideasKey(uid));
            if (cached) { res.json({ ...cached, cached: true, usage: await usageSnapshot(uid) }); return; }
        }

        const ctx = await newCtx();
        const store = await loadStore(ctx, uid);
        const top = [...store.agg.values()].filter(a => a.units > 0).sort((a, b) => b.units - a.units).slice(0, IDEA_SOURCES);
        if (top.length === 0) {
            throw new AiError(422, 'NO_SALES_DATA', 'Todavía no hay ventas en los últimos 90 días para proponer ideas.');
        }
        if (store.ordersTruncated) {
            throw new AiError(503, 'METRICS_UNAVAILABLE', 'No se pudieron leer completas las órdenes de Mercado Libre. Intenta de nuevo en un momento.');
        }

        // Detalle (atributos y variantes existentes) de los más vendidos: solo se conservan los que son de esta cuenta
        const details = new Map<string, any>();
        const rows: any[] = await mlGet(ctx, `${ML_API}/items`, { ids: top.map(t => t.id).join(',') });
        rows.filter(r => r.code === 200 && String(r.body?.seller_id) === uid).forEach(r => details.set(r.body.id, r.body));
        const visitsOf = new Map(store.items.map(i => [i.id, i.visits]));
        const sources: IdeaSource[] = top.filter(t => details.has(t.id)).map(t => {
            const d = details.get(t.id);
            return {
                id: t.id, title: String(d.title ?? t.title), price: d.price ?? null, units: t.units, orders: t.orders,
                visits: visitsOf.get(t.id) ?? null, attributes: pickAttributes(d.attributes),
                variations: (d.variations || []).map((v: any) => (v.attribute_combinations || []).map((a: any) => a?.value_name).filter(Boolean).join(' / ')).filter(Boolean),
            };
        });
        if (sources.length === 0) throw new AiError(422, 'NO_SALES_DATA', 'No se pudieron leer los productos más vendidos.');

        const existingTitles = [...new Set([...store.items.map(i => i.title), ...store.agg.values()].map(x => typeof x === 'string' ? x : x.title))].filter(Boolean);
        const prompt = buildIdeasPrompt(WINDOW_DAYS, sources, existingTitles);

        await reserveUse(uid);
        let out: { data: IdeasOut; usage: AiUsage };
        try {
            out = await callStructured('ideas', IdeasSchema, SYSTEM_PROMPT, prompt);
        } catch (e) {
            if (!(e instanceof AiError && BILLED_CODES.has(e.code))) await refundUse(uid);
            throw e;
        }

        const sourceById = new Map(sources.map(s => [s.id, s]));
        const { kept, dropped } = filterTitles(out.data.ideas);
        let nearDuplicates = 0, badSource = 0;
        const ideas = kept.filter(idea => {
            if (!sourceById.has(idea.source_item_id)) { badSource++; return false; }
            // Copia cosmética: demasiado parecida a cualquier publicación existente
            if (existingTitles.some(t => isCosmeticCopy(idea.title, t))) { nearDuplicates++; return false; }
            return true;
        }).slice(0, MAX_IDEAS).map(idea => ({
            title: idea.title, kind: idea.kind, source_item_id: idea.source_item_id,
            source_title: sourceById.get(idea.source_item_id)!.title,
            data_behind: String(idea.data_behind ?? ''), confirm_stock: idea.confirm_stock.map(String).filter(Boolean),
            length: idea.title.length,
        }));
        const warnings: string[] = [];
        if (nearDuplicates) warnings.push(`Se descartaron ${nearDuplicates} idea(s) demasiado parecidas a publicaciones que ya tienes (copias con otro título pueden violar las reglas de ML).`);
        if (dropped.length || badSource) warnings.push(`Se descartaron ${dropped.length + badSource} idea(s) por no cumplir las reglas de título u origen.`);
        if (ideas.length === 0) warnings.push('Ninguna idea cumplió las reglas. Prueba "Regenerar".');

        const body = { generatedAt: new Date().toISOString(), window: { days: WINDOW_DAYS, from: store.from, to: store.to }, ideas, warnings };
        await storeSet(ideasKey(uid), body, CACHE_TTL_S);
        res.json({ ...body, cached: false, usage: await usageSnapshot(uid) });
    } catch (error) {
        sendError(res, error, 'ideas');
    }
});

// ---------------- Cambios aplicados ----------------
interface AppliedRecord {
    uid: string; itemId: string; field: 'title' | 'description'; before: string; after: string;
    appliedAt: string; appliedDay: string; verified: boolean;
    baseline: { days: number; visits: number | null; orders: number | null };
}

router.post('/applied', async (req: Request, res: Response) => {
    try {
        const uid = currentUid();
        const itemId = parseItemId(req.body?.itemId);
        const field = req.body?.field;
        if (field !== 'title' && field !== 'description') throw new BadRequest("field debe ser 'title' o 'description'");
        const { before, after } = req.body || {};
        const max = field === 'title' ? 200 : 50000;
        if (typeof before !== 'string' || typeof after !== 'string' || before.length > max || after.length > max) throw new BadRequest('before/after inválidos');
        if (!after.trim()) throw new BadRequest('after no puede estar vacío');

        const ctx = await newCtx();
        const item = await readOwnItem(ctx, uid, itemId);
        const verified = field === 'title'
            ? String(item.title).trim() === after.trim()
            : (await readDescription(ctx, itemId)).trim() === after.trim();

        // Línea base: visitas y órdenes de los 30 días anteriores al día del cambio
        const today = todayInTz();
        let visits: number | null = null, orders: number | null = null;
        const days = await itemDaily(ctx, itemId, 31);
        if (days) visits = sumRange(days, addDays(today, -30), addDays(today, -1));
        try {
            const fromIso = new Date(startOfDayUtc(addDays(today, -30), TZ)).toISOString();
            const toIso = new Date(startOfDayUtc(today, TZ) - 1).toISOString();
            const r = await fetchOrders(ctx, fromIso, toIso);
            if (!r.truncated) orders = aggregateOrders(r.orders).get(itemId)?.orders ?? 0;
        } catch (e) { console.warn(`opportunities applied: órdenes de línea base no disponibles: ${safeError(e)}`); }

        const now = new Date();
        const rec: AppliedRecord = {
            uid, itemId, field, before, after, appliedAt: now.toISOString(), appliedDay: today, verified,
            baseline: { days: 30, visits, orders },
        };
        const key = changeKey(uid, itemId, now.getTime());
        await storeSet(key, rec);
        const idx = (await storeGet<string[]>(changeIndexKey(uid))) ?? [];
        await storeSet(changeIndexKey(uid), [key, ...idx].slice(0, MAX_APPLIED));
        res.status(201).json({ key, record: publicRecord(rec) });
    } catch (error) {
        sendError(res, error, 'applied');
    }
});

const publicRecord = (r: AppliedRecord) => ({
    itemId: r.itemId, field: r.field, before: r.before, after: r.after,
    appliedAt: r.appliedAt, appliedDay: r.appliedDay, verified: r.verified, baseline: r.baseline,
});

const COMPARISON_NOTE = 'Comparación descriptiva de lo que pasó antes y después. Otros factores (temporada, precio, competencia, stock) también cambian: estos números no demuestran que el cambio fue la causa.';

router.get('/applied', async (_req: Request, res: Response) => {
    try {
        const uid = currentUid();
        const keys = ((await storeGet<string[]>(changeIndexKey(uid))) ?? []).filter(k => k.startsWith(`ai_change:${uid}:`)).slice(0, APPLIED_LIST);
        const records: AppliedRecord[] = [];
        for (const k of keys) {
            const r = await storeGet<AppliedRecord>(k);
            if (r && r.uid === uid) records.push(r);
        }
        if (records.length === 0) { res.json({ changes: [], minDays: MIN_DAYS_FOR_RESULTS, minVisits: MIN_VISITS_FOR_RESULTS, note: COMPARISON_NOTE }); return; }

        const today = todayInTz();
        const ctx = await newCtx();
        // Visitas por publicación (una vez por publicación) y órdenes desde el cambio más antiguo
        const itemIds = [...new Set(records.map(r => r.itemId))];
        const visitDays = new Map<string, Awaited<ReturnType<typeof itemDaily>>>();
        for (const id of itemIds) {
            const maxAge = Math.max(...records.filter(r => r.itemId === id).map(r => diffDays(r.appliedDay, today)));
            visitDays.set(id, await itemDaily(ctx, id, Math.min(150, Math.max(2, maxAge + 1))));
        }
        const earliest = records.map(r => r.appliedDay).sort()[0];
        let ordersCache: any[] | null = null;
        if (addDays(earliest, 1) < today) {
            try {
                const fromIso = new Date(startOfDayUtc(addDays(earliest, 1), TZ)).toISOString();
                const toIso = new Date(startOfDayUtc(today, TZ) - 1).toISOString();
                const r = await fetchOrders(ctx, fromIso, toIso);
                if (!r.truncated) ordersCache = r.orders;
            } catch (e) { console.warn(`opportunities applied: órdenes no disponibles: ${safeError(e)}`); }
        }

        const changes = records.map(r => {
            const daysElapsed = diffDays(r.appliedDay, today);
            const afterDays = Math.max(0, daysElapsed - 1); // días completos después del día del cambio (hoy no cuenta)
            // Texto del cambio como textBefore/textAfter; before/after quedan para las métricas de la comparación
            const { before: textBefore, after: textAfter, ...rest } = publicRecord(r);
            const base = { ...rest, textBefore, textAfter, daysElapsed, afterDays };
            const vd = visitDays.get(r.itemId);
            const afterFrom = addDays(r.appliedDay, 1), afterTo = addDays(today, -1);
            const visitsAfter = vd && afterDays > 0 ? sumRange(vd, afterFrom, afterTo) : null;
            let ordersAfter: number | null = null;
            if (ordersCache && afterDays > 0) {
                const lo = new Date(startOfDayUtc(afterFrom, TZ)).toISOString(), hi = new Date(startOfDayUtc(today, TZ)).toISOString();
                const onlyAfter = ordersCache.filter(o => o?.date_created && o.date_created >= lo && o.date_created < hi); // días completos, sin hoy
                ordersAfter = aggregateOrders(onlyAfter).get(r.itemId)?.orders ?? 0;
            }
            const b = r.baseline;
            let status: 'insufficient' | 'ready' | 'unavailable' = 'ready';
            let reason = '';
            if (afterDays < MIN_DAYS_FOR_RESULTS) {
                status = 'insufficient'; reason = `Todavía sin datos suficientes: han pasado ${daysElapsed} día(s) y se necesitan al menos ${MIN_DAYS_FOR_RESULTS} días completos.`;
            } else if (visitsAfter === null || ordersAfter === null || b.visits === null || b.orders === null) {
                status = 'unavailable'; reason = 'No se pudieron leer todos los datos de visitas u órdenes para comparar.';
            } else if (visitsAfter < MIN_VISITS_FOR_RESULTS || b.visits < MIN_VISITS_FOR_RESULTS) {
                status = 'insufficient'; reason = `Todavía sin datos suficientes: se necesitan al menos ${MIN_VISITS_FOR_RESULTS} visitas antes y después para comparar.`;
            }
            if (status !== 'ready') {
                return { ...base, status, reason, before: null, after: null };
            }
            const bd = b.days;
            return {
                ...base, status, reason: '',
                before: { days: bd, visits: b.visits, orders: b.orders, visitsPerDay: round2((b.visits as number) / bd), ordersPerDay: round2((b.orders as number) / bd), conversionPct: pct(b.orders as number, b.visits as number) },
                after: { days: afterDays, visits: visitsAfter, orders: ordersAfter, visitsPerDay: round2((visitsAfter as number) / afterDays), ordersPerDay: round2((ordersAfter as number) / afterDays), conversionPct: pct(ordersAfter as number, visitsAfter as number) },
            };
        });
        res.json({ changes, minDays: MIN_DAYS_FOR_RESULTS, minVisits: MIN_VISITS_FOR_RESULTS, note: COMPARISON_NOTE });
    } catch (error) {
        sendError(res, error, 'applied-list');
    }
});

export default router;
