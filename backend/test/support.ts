// Infraestructura de pruebas: KV falso, ML falso (dos cuentas) y bloqueo de cualquier URL real.
// Este archivo DEBE importarse antes que cualquier módulo de la app.
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import axios, { AxiosError } from 'axios';

// ---- Entorno aislado: nada real. dotenv no pisa variables ya definidas y se cambia el cwd para que no lea ningún .env.
for (const k of Object.keys(process.env)) {
    if (/^(KV_|APP_|REDIRECT_|SESSION_|ALLOWED_|LOCAL_DEV|FRONTEND_|AWS_LAMBDA|VERCEL|NODE_ENV|PORT)/.test(k)) delete process.env[k];
}
process.env['KV_REST_API_URL'] = 'https://fake-kv.test';
process.env['KV_REST_API_TOKEN'] = 'fake-kv-token';
process.env['APP_ID'] = 'fake-app';
process.env['APP_SECRET'] = 'fake-app-secret';
process.env['REDIRECT_URI'] = 'https://app.test/api/callback';
process.env['SESSION_SECRET'] = 'test-session-secret';
process.env['FRONTEND_URL'] = 'https://app.test';
process.env['VERCEL'] = '1'; // serverless: jamás lee/escribe tokens.json; no abre puerto al importar api/index.ts
process.env['ALLOWED_ML_USER_ID'] = '111,222';
process.chdir(os.tmpdir());

export const A = 111;   // "dueño" (puede tener token heredado en KV)
export const B = 222;   // segunda tienda

const realFetch = globalThis.fetch;
const REAL_BLOCK = (what: string) => new Error(`BLOCKED real network access in tests: ${what}`);

// ---------------- KV falso ----------------
export const kv = {
    data: new Map<string, string>(),
    log: [] as { cmd: string; key: string }[],
    failReads: false,
    failIncr: false,
    reset() { this.data.clear(); this.log = []; this.failReads = false; this.failIncr = false; },
    writes() { return this.log.filter(l => l.cmd === 'SET' || l.cmd === 'DEL'); },
    put(key: string, value: any) { this.data.set(key, typeof value === 'string' ? value : JSON.stringify(value)); },
    get(key: string) { const v = this.data.get(key); return v ? JSON.parse(v) : null; },
};

globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(typeof input === 'string' ? input : input?.url);
    if (url.startsWith('http://127.0.0.1:')) return realFetch(input, init); // servidor de prueba local
    if (!url.startsWith('https://fake-kv.test')) throw REAL_BLOCK(url);
    const [cmd, key, value] = JSON.parse(init.body);
    kv.log.push({ cmd, key });
    let result: any = null;
    if (cmd === 'GET') {
        if (kv.failReads) return new Response('boom', { status: 500 });
        result = kv.data.get(key) ?? null;
    } else if (cmd === 'SET') { kv.data.set(key, value); result = 'OK'; }
    else if (cmd === 'DEL') { result = kv.data.delete(key) ? 1 : 0; }
    else if (cmd === 'INCR') { if (kv.failIncr) return new Response('boom', { status: 500 }); result = Number(kv.data.get(key) ?? 0) + 1; kv.data.set(key, String(result)); }
    else if (cmd === 'DECR') { result = Number(kv.data.get(key) ?? 0) - 1; kv.data.set(key, String(result)); }
    else if (cmd === 'EXPIRE') { result = 1; }
    else if (cmd === 'PING') result = 'PONG';
    return new Response(JSON.stringify({ result }), { status: 200 });
}) as any;

// ---------------- ML falso ----------------
export interface MlCall { method: string; url: string; token: string | null; uid: number | null; }
export const today = () => new Date().toISOString().slice(0, 10);

export const ml = {
    calls: [] as MlCall[],
    access: new Map<string, number>(),                       // access_token -> uid
    refresh: new Map<string, { uid: number; used: boolean }>(),
    omitUserIdOnRefresh: false,
    onRefresh: null as null | (() => void), // gancho: simula a otra instancia rotando el token durante el refresh
    delayMs: 0,
    seq: 0,
    reset() { this.calls = []; this.access.clear(); this.refresh.clear(); this.omitUserIdOnRefresh = false; this.onRefresh = null; this.delayMs = 0; this.seq = 0; },
    register(uid: number, access: string, refresh: string) { this.access.set(access, uid); this.refresh.set(refresh, { uid, used: false }); },
    callsFor(uid: number) { return this.calls.filter(c => c.uid === uid); },
    refreshCalls() { return this.calls.filter(c => c.url === '/oauth/token'); },
};

export const makeToken = (uid: number, over: Record<string, any> = {}) => ({
    access_token: `AT-${uid}-0`, token_type: 'Bearer', expires_in: 21600, scope: 'offline_access read write',
    user_id: uid, refresh_token: `RT-${uid}-0`, created_at: Date.now(), ...over,
});

const fail = (config: any, status: number, data: any) => {
    const res = { data, status, statusText: String(status), headers: {}, config };
    return new AxiosError(`status ${status}`, 'ERR_BAD_REQUEST', config, null, res as any);
};

const itemsOf = (uid: number) => [1, 2, 3].map(i => ({
    id: `MLM${uid}00${i}`, title: `Item of ${uid} #${i}`, price: 100 * i + (uid === A ? 1 : 2), available_quantity: 5,
    sold_quantity: i, status: 'active', thumbnail: null, listing_type_id: 'gold_special', condition: 'new',
    permalink: `https://ml.test/${uid}/${i}`, date_created: '2024-01-01T00:00:00Z', last_updated: '2024-01-02T00:00:00Z', shipping: { free_shipping: false },
}));

axios.defaults.adapter = async (config: any) => {
    const u = new URL(config.url, 'https://api.mercadolibre.com');
    if (u.host !== 'api.mercadolibre.com') throw REAL_BLOCK(u.href);
    if (config.params) for (const [k, v] of Object.entries(config.params)) u.searchParams.set(k, String(v));
    const method = String(config.method || 'get').toUpperCase();
    const authH = config.headers?.get ? config.headers.get('Authorization') : config.headers?.Authorization;
    const bearer = authH ? String(authH).replace(/^Bearer /, '') : null;
    const uid = bearer ? (ml.access.get(bearer) ?? null) : null;
    ml.calls.push({ method, url: u.pathname + u.search, token: bearer, uid });
    if (ml.delayMs) await new Promise(r => setTimeout(r, Math.random() * ml.delayMs));
    const ok = (data: any, status = 200) => {
        if (config.validateStatus ? !config.validateStatus(status) : status >= 400) throw fail(config, status, data);
        return { data, status, statusText: 'OK', headers: {}, config };
    };
    const p = u.pathname;

    if (p === '/oauth/token') {
        const form = new URLSearchParams(String(config.data));
        if (form.get('grant_type') === 'refresh_token') {
            if (ml.onRefresh) { const f = ml.onRefresh; ml.onRefresh = null; f(); }
            const r = ml.refresh.get(form.get('refresh_token') || '');
            if (!r || r.used) throw fail(config, 400, { error: 'invalid_grant' });
            r.used = true;
            const n = ++ml.seq;
            const out: any = { access_token: `AT-${r.uid}-r${n}`, token_type: 'Bearer', expires_in: 21600, scope: 'x', refresh_token: `RT-${r.uid}-r${n}` };
            if (!ml.omitUserIdOnRefresh) out.user_id = r.uid;
            ml.register(r.uid, out.access_token, out.refresh_token);
            return ok(out);
        }
        const cm = /^code-(\d+)$/.exec(form.get('code') || '');
        if (!cm) throw fail(config, 400, { error: 'invalid_grant' });
        const id = Number(cm[1]);
        const n = ++ml.seq;
        const out = { access_token: `AT-${id}-l${n}`, token_type: 'Bearer', expires_in: 21600, scope: 'x', user_id: id, refresh_token: `RT-${id}-l${n}` };
        ml.register(id, out.access_token, out.refresh_token);
        return ok(out);
    }

    if (uid === null) throw fail(config, 401, { message: 'invalid token' });
    const mine = (id: string) => { if (Number(id) !== uid) throw fail(config, 403, { message: 'forbidden: other account' }); };

    if (p === '/users/me') return ok({ id: uid, nickname: `nick-${uid}` });
    let m: RegExpExecArray | null;
    if ((m = /^\/users\/(\d+)\/items\/search$/.exec(p))) {
        mine(m[1]);
        return ok({ results: itemsOf(uid).map(i => i.id), paging: { total: 3, offset: 0, limit: 100 } });
    }
    if (p === '/items' && u.searchParams.get('ids')) {
        const ids = u.searchParams.get('ids')!.split(',');
        const all = itemsOf(uid);
        return ok(ids.map(id => { const f = all.find(i => i.id === id); return f ? { code: 200, body: f } : { code: 404, body: {} }; }));
    }
    if (/^\/items\/(MLM\d+)\/visits\/time_window$/.test(p)) {
        return ok({ results: [{ date: `${today()}T00:00:00Z`, total: uid === A ? 7 : 9 }] });
    }
    if ((m = /^\/users\/(\d+)\/items_visits\/time_window$/.exec(p))) {
        mine(m[1]);
        return ok({ results: [{ date: `${today()}T00:00:00Z`, total: uid === A ? 70 : 90 }] });
    }
    if (p === '/orders/search') {
        mine(u.searchParams.get('seller') || '0');
        const mkOrder = (i: number) => ({
            id: uid * 1000 + i, date_created: new Date().toISOString(), status: 'paid', fulfilled: true,
            total_amount: uid === A ? 1000 : 2000, order_items: [{ item: { id: `MLM${uid}001`, title: `Item of ${uid}` }, quantity: 1, sale_fee: 10, unit_price: 100 }],
            shipping: { id: i }, // mismos ids de envío en ambas cuentas: detecta fugas de la caché de envíos
        });
        return ok({ results: [mkOrder(1), mkOrder(2)], paging: { total: 2, offset: 0, limit: 50 } });
    }
    if (/^\/shipments\/(\d+)\/costs$/.test(p)) return ok({ senders: [{ user_id: uid, cost: uid === A ? 11 : 22 }] });
    if ((m = /^\/shipments\/(\d+)$/.exec(p))) return ok({ id: Number(m[1]), status: uid === A ? 'ready_to_ship' : 'delivered', shipping_option: { list_cost: 5 } });
    return ok({});
};

// ---------------- Utilidades ----------------
export const sessionCookie = (uid: number, over: Record<string, any> = {}) => {
    const data = Buffer.from(JSON.stringify({ uid, exp: Date.now() + 3600_000, ...over })).toString('base64url');
    const sig = crypto.createHmac('sha256', process.env['SESSION_SECRET']!).update(data).digest('base64url');
    return `ml_session=${data}.${sig}`;
};

/** Módulos de la app NUEVOS (singletons, cachés y contexto limpios). */
export const freshApp = () => {
    const root = path.resolve(__dirname, '..', '..');
    for (const k of Object.keys(require.cache)) {
        if (k.startsWith(root) && !k.includes('node_modules') && !k.includes(`${path.sep}test${path.sep}`)) delete require.cache[k];
    }
    const index = require(path.join(root, 'api', 'index.ts'));
    const oauth = require(path.join(root, 'backend', 'src', 'auth', 'oauth.ts'));
    const context = require(path.join(root, 'backend', 'src', 'auth', 'context.ts'));
    oauth.__setRecoveryWaitForTests(0);
    return { app: index.default, mlAuth: oauth.mlAuth, oauth, context };
};

export const withServer = async (app: any, fn: (base: string) => Promise<void>) => {
    const server = app.listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    try { await fn(`http://127.0.0.1:${server.address().port}`); }
    finally { await new Promise(r => server.close(r)); }
};

export const get = async (base: string, p: string, uid?: number, extra: Record<string, string> = {}) => {
    const headers: Record<string, string> = { ...extra };
    if (uid !== undefined) headers['cookie'] = sessionCookie(uid);
    const r = await fetch(base + p, { headers });
    return { status: r.status, body: await r.json().catch(() => null) as any };
};

/** Guarda un token válido de cada cuenta en KV (clave por uid) y lo registra en el ML falso. */
export const seedBoth = () => {
    for (const uid of [A, B]) {
        const t = makeToken(uid);
        kv.put(`meli_oauth_token_v2:${uid}`, t);
        ml.register(uid, t.access_token, t.refresh_token);
    }
};

export const resetAll = () => { kv.reset(); ml.reset(); };
