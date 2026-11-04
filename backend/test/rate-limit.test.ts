import { A, B, kv, ml, freshApp, resetAll, seedBoth, sessionCookie, withServer } from './support';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { KvWindowStore, RATE_LIMITS } from '../src/rate-limit';

beforeEach(resetAll);

const hit = (base: string, path: string, init: RequestInit = {}) => fetch(base + path, init);
const from = (ip: string): RequestInit => ({ headers: { 'x-forwarded-for': ip } });
const ofAccount = (uid: number, method = 'GET'): RequestInit => ({ method, headers: { cookie: sessionCookie(uid) } });

const hitTimes = async (times: number, base: string, path: string, init: RequestInit = {}) => {
    const statuses: number[] = [];
    for (let i = 0; i < times; i++) statuses.push((await hit(base, path, init)).status);
    return statuses;
};

const WINDOW_MS = 60_000;
const seedWrites = (uid: number, count: number) => {
    // La ventana actual y la siguiente: la prueba no depende de cruzar un cambio de minuto
    const window = Math.floor(Date.now() / WINDOW_MS);
    kv.put(`rate_write:${uid}:${window}`, String(count));
    kv.put(`rate_write:${uid}:${window + 1}`, String(count));
};

test('sin sesión: 429 al pasar el límite, con Retry-After, sin llamadas a ML; otra IP sigue pasando', async () => {
    const { app } = freshApp();
    await withServer(app, async base => {
        const statuses = await hitTimes(RATE_LIMITS.anonymous + 1, base, '/api/items', from('203.0.113.1'));
        assert.deepEqual(statuses.slice(0, -1), Array(RATE_LIMITS.anonymous).fill(401));
        assert.equal(statuses.at(-1), 429);

        const limited = await hit(base, '/api/items', from('203.0.113.1'));
        const body: any = await limited.json();
        assert.equal(body.code, 'RATE_LIMITED');
        assert.match(body.error, /Demasiadas peticiones/);
        assert.ok(Number(limited.headers.get('retry-after')) > 0);

        assert.equal((await hit(base, '/api/items', from('203.0.113.2'))).status, 401);
        assert.equal(ml.calls.length, 0);
    });
});

test('login: /api/callback tiene un límite más bajo y no llega a ML al pasarlo', async () => {
    const { app } = freshApp();
    await withServer(app, async base => {
        const init: RequestInit = { ...from('203.0.113.3'), redirect: 'manual' };
        const statuses = await hitTimes(RATE_LIMITS.login + 1, base, '/api/callback?code=code-111&state=x', init);
        assert.ok(statuses.slice(0, -1).every(s => s === 302), statuses.join());
        assert.equal(statuses.at(-1), 429);
        // Otras rutas públicas no comparten este límite más bajo
        assert.equal((await hit(base, '/api/auth/status', from('203.0.113.3'))).status, 200);
        assert.equal(ml.refreshCalls().length, 0);
    });
});

test('con sesión no se aplica el límite por IP', async () => {
    seedBoth();
    const { app } = freshApp();
    await withServer(app, async base => {
        const init = { headers: { cookie: sessionCookie(A), 'x-forwarded-for': '203.0.113.4' } };
        const statuses = await hitTimes(RATE_LIMITS.anonymous + 5, base, '/api', init);
        assert.ok(statuses.every(s => s === 200), statuses.join());
    });
});

test('escrituras: al pasar el límite no llegan a ML, y una cuenta no gasta el límite de la otra', async () => {
    seedBoth();
    const { app } = freshApp();
    seedWrites(A, RATE_LIMITS.accountWrites);
    await withServer(app, async base => {
        const rejected = await hit(base, '/api/items/MLM111001', {
            ...ofAccount(A, 'PUT'),
            headers: { ...ofAccount(A).headers, 'content-type': 'application/json' },
            body: JSON.stringify({ price: 10 }),
        });
        assert.equal(rejected.status, 429);
        assert.equal(ml.callsFor(A).length, 0, 'la escritura rechazada no debe llamar a ML');

        // Las lecturas no cuentan contra el límite de escritura
        assert.equal((await hit(base, '/api', ofAccount(A))).status, 200);

        // Sin cambios: la cuenta B sí llega a la validación de la ruta
        const other = await hit(base, '/api/items/MLM222001', {
            method: 'PUT',
            headers: { cookie: sessionCookie(B), 'content-type': 'application/json' },
            body: '{}',
        });
        assert.equal(other.status, 400);
    });
});

test('KV caído: las escrituras siguen funcionando', async () => {
    seedBoth();
    kv.failIncr = true;
    const { app } = freshApp();
    await withServer(app, async base => {
        const r = await hit(base, '/api/items/MLM111001', {
            method: 'PUT',
            headers: { cookie: sessionCookie(A), 'content-type': 'application/json' },
            body: '{}',
        });
        assert.equal(r.status, 400);
    });
});

test('el limitador conserva la cuenta de la petición', async () => {
    seedBoth();
    const { app } = freshApp();
    await withServer(app, async base => {
        const [a, b] = await Promise.all([
            hit(base, '/api/items/MLM111001', { method: 'PUT', headers: { cookie: sessionCookie(A), 'content-type': 'application/json' }, body: JSON.stringify({ price: 55 }) }),
            hit(base, '/api/items/MLM222001', { method: 'PUT', headers: { cookie: sessionCookie(B), 'content-type': 'application/json' }, body: JSON.stringify({ price: 66 }) }),
        ]);
        assert.ok(a.status < 500 && b.status < 500);
        assert.ok(ml.calls.filter(c => c.url.includes('MLM111001')).every(c => c.uid === A));
        assert.ok(ml.calls.filter(c => c.url.includes('MLM222001')).every(c => c.uid === B));
        assert.ok(kv.log.some(l => l.key.startsWith(`rate_write:${A}:`)));
        assert.ok(kv.log.some(l => l.key.startsWith(`rate_write:${B}:`)));
    });
});

test('KvWindowStore: cuenta dentro de la ventana y reinicia en la siguiente', async () => {
    let now = 10 * WINDOW_MS + 5_000;
    const store = new KvWindowStore(() => now);
    store.init({ windowMs: WINDOW_MS } as any);

    assert.equal((await store.increment('u')).totalHits, 1);
    const second = await store.increment('u');
    assert.equal(second.totalHits, 2);
    assert.equal(second.resetTime!.getTime(), 11 * WINDOW_MS);

    now = 11 * WINDOW_MS;
    assert.equal((await store.increment('u')).totalHits, 1);
    assert.ok(kv.log.some(l => l.cmd === 'EXPIRE'), 'el contador debe caducar');
});
