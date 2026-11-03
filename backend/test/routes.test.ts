import { A, B, kv, ml, freshApp, resetAll, seedBoth, withServer, get, sessionCookie, today } from './support';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { parseAllowedIds } from '../src/auth/allowlist';

beforeEach(resetAll);

const q = () => `from=${today()}&to=${today()}&tz=UTC`;
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f0005fe02fea7d6d5e40000000049454e44ae426082', 'hex');

test('allow-list: parseo de ids separados por coma', () => {
    assert.deepEqual(parseAllowedIds('123'), ['123']);
    assert.deepEqual(parseAllowedIds(' 123 , 456 ,, '), ['123', '456']);
    assert.deepEqual(parseAllowedIds(''), []);
    assert.deepEqual(parseAllowedIds(undefined), []);
    assert.deepEqual(parseAllowedIds(' , '), []);
});

test('allow-list: vacía = nadie; un solo id se comporta como antes; modo local usa LOCAL_DEV_UID o el primero', () => {
    const { context } = freshApp();
    const prev = process.env['ALLOWED_ML_USER_ID'];
    try {
        process.env['ALLOWED_ML_USER_ID'] = '';
        assert.equal(context.localDevUid(), null);
        assert.throws(() => context.runWithAccount(A, () => context.currentUid()));
        process.env['ALLOWED_ML_USER_ID'] = '111';
        assert.equal(context.runWithAccount(111, () => context.currentUid()), '111');
        assert.throws(() => context.runWithAccount(112, () => context.currentUid()));
        process.env['ALLOWED_ML_USER_ID'] = '111,222';
        assert.equal(context.localDevUid(), '111');
        process.env['LOCAL_DEV_UID'] = '222';
        assert.equal(context.localDevUid(), '222');
    } finally { process.env['ALLOWED_ML_USER_ID'] = prev; delete process.env['LOCAL_DEV_UID']; }
});

test('sin sesión -> 401 y sin llamadas a ML; sesión de un id retirado -> 401', async () => {
    seedBoth();
    const { app } = freshApp();
    await withServer(app, async base => {
        for (const p of ['/api/summary?' + q(), '/api/summary/pending', '/api/analytics/items?' + q(), '/api/items?q=item']) {
            assert.equal((await get(base, p)).status, 401, p);
        }
        assert.equal((await get(base, '/api/summary/pending', 999)).status, 401, 'uid fuera de la lista');
        assert.equal((await get(base, '/api/summary/pending', A)).status, 200);
        process.env['ALLOWED_ML_USER_ID'] = String(B);   // se retira A de la lista
        try {
            assert.equal((await get(base, '/api/summary/pending', A)).status, 401);
            assert.equal((await get(base, '/api/summary/pending', B)).status, 200);
            const st = await get(base, '/api/auth/status', A);
            assert.equal(st.body.authenticated, false);
        } finally { process.env['ALLOWED_ML_USER_ID'] = `${A},${B}`; }
    });
});

test('/api/auth/status devuelve id y apodo de la cuenta (caché por uid)', async () => {
    seedBoth();
    const { app } = freshApp();
    await withServer(app, async base => {
        const a = (await get(base, '/api/auth/status', A)).body;
        const b = (await get(base, '/api/auth/status', B)).body;
        const a2 = (await get(base, '/api/auth/status', A)).body;
        assert.deepEqual([a.userId, a.nickname, a.connected, a.authenticated], [A, `nick-${A}`, true, true]);
        assert.deepEqual([b.userId, b.nickname], [B, `nick-${B}`]);
        assert.equal(a2.nickname, `nick-${A}`);
        assert.equal(ml.calls.filter(c => c.url === '/users/me' && c.uid === A).length, 1, 'apodo cacheado por uid');
        const anon = (await get(base, '/api/auth/status')).body;
        assert.deepEqual([anon.authenticated, anon.userId, anon.nickname, anon.connected], [false, null, null, false]);
    });
});

test('cachés: /api/summary, /pending, /analytics/items y /items nunca devuelven datos de otra cuenta', async () => {
    seedBoth();
    const { app } = freshApp();
    await withServer(app, async base => {
        for (let round = 0; round < 2; round++) {          // 2ª ronda = respuestas cacheadas
            for (const [first, second] of [[A, B], [B, A]]) {
                const rs = await Promise.all([first, second].map(uid => get(base, '/api/summary?' + q(), uid)));
                [first, second].forEach((uid, i) => {
                    const body = rs[i].body;
                    assert.equal(rs[i].status, 200);
                    assert.ok(body.orders.length > 0);
                    assert.ok(body.orders.every((o: any) => String(o.id).startsWith(String(uid))), `summary de ${uid}`);
                    assert.ok(body.orders.every((o: any) => o.total_amount === (uid === A ? 1000 : 2000)));
                    assert.ok(body.orders.every((o: any) => o.listCost === (uid === A ? 11 : 22)), 'costo de envío de la cuenta correcta');
                });
                const ps = await Promise.all([first, second].map(uid => get(base, '/api/summary/pending', uid)));
                [first, second].forEach((uid, i) => assert.equal(ps[i].body.count, uid === A ? 2 : 0, `pending de ${uid}`));

                const an = await Promise.all([first, second].map(uid => get(base, '/api/analytics/items?' + q(), uid)));
                [first, second].forEach((uid, i) => {
                    assert.equal(an[i].status, 200);
                    assert.ok(an[i].body.items.length === 3 && an[i].body.items.every((it: any) => it.id.startsWith(`MLM${uid}`)), `analytics de ${uid}`);
                    assert.ok(an[i].body.items.every((it: any) => it.visits === (uid === A ? 7 : 9)));
                });

                const it = await Promise.all([first, second].map(uid => get(base, '/api/items?q=item&sort=price_asc', uid)));
                [first, second].forEach((uid, i) => {
                    assert.equal(it[i].status, 200);
                    assert.equal(it[i].body.items.length, 3);
                    assert.ok(it[i].body.items.every((x: any) => x.id.startsWith(`MLM${uid}`) && x.title.includes(String(uid))), `items de ${uid}`);
                });
            }
        }
        // Ninguna llamada a ML con token desconocido ni de una cuenta sobre recursos de otra (el ML falso devolvería 403)
        assert.ok(ml.calls.every(c => c.uid !== null), 'toda llamada lleva el token de una cuenta');
    });
});

test('peticiones concurrentes e intercaladas de dos cuentas (pools incluidos) usan siempre su token', async () => {
    seedBoth();
    ml.delayMs = 6;
    const { app } = freshApp();
    await withServer(app, async base => {
        const paths = ['/api/summary?' + q() + '&includeUnfulfilled=1', '/api/analytics/items?' + q(), '/api/items?status=active&limit=10'];
        const jobs: Promise<any>[] = [];
        for (let i = 0; i < 12; i++) for (const uid of [A, B]) {
            const p = paths[i % paths.length];
            jobs.push(get(base, p, uid).then(r => ({ uid, p, r })));
        }
        for (const { uid, p, r } of await Promise.all(jobs)) {
            assert.equal(r.status, 200, `${p} ${uid}`);
            assert.ok(!JSON.stringify(r.body).includes(`${uid === A ? B : A}00`) , `${p}: sin ids de la otra cuenta`);
        }
        const bad = ml.calls.filter(c => c.uid === null);
        assert.equal(bad.length, 0);
    });
});

test('una ruta de escritura de la cuenta A solo llama a ML con el token de A', async () => {
    seedBoth();
    const { app } = freshApp();
    await withServer(app, async base => {
        for (const [uid, other] of [[A, B], [B, A]]) {
            ml.calls = [];
            const r = await fetch(`${base}/api/items/MLM${uid}001/description`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', cookie: sessionCookie(uid) },
                body: JSON.stringify({ plain_text: 'hola' }),
            });
            assert.equal(r.status, 200);
            const writes = ml.calls.filter(c => c.method !== 'GET');
            assert.ok(writes.length > 0, 'hubo escritura simulada');
            assert.ok(writes.every(c => c.uid === uid && c.token === `AT-${uid}-0`), 'solo token de la cuenta de la sesión');
            assert.equal(ml.callsFor(other).length, 0);
        }
        // sin sesión no hay ninguna llamada
        ml.calls = [];
        const anon = await fetch(`${base}/api/items/MLM111001/description`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"plain_text":"x"}' });
        assert.equal(anon.status, 401);
        assert.equal(ml.calls.length, 0);
    });
});

test('la subida de imágenes (multer) conserva la cuenta tras el callback', async () => {
    seedBoth();
    const { app } = freshApp();
    await withServer(app, async base => {
        for (const uid of [A, B, A, B]) {
            ml.calls = [];
            const fd = new FormData();
            fd.append('file', new Blob([PNG], { type: 'image/png' }), 'x.png');
            const r = await fetch(`${base}/api/images/upload`, { method: 'POST', headers: { cookie: sessionCookie(uid) }, body: fd });
            assert.equal(r.status, 200, await r.clone().text());
            const up = ml.calls.filter(c => c.method === 'POST');
            assert.equal(up.length, 1);
            assert.equal(up[0].token, `AT-${uid}-0`);
        }
    });
});

test('callback OAuth: B entra con su cuenta, no se emite sesión a no permitidos', async () => {
    const { app } = freshApp();
    await withServer(app, async base => {
        const state = 'st';
        const oauthCookie = `ml_oauth=${encodeURIComponent(JSON.stringify({ state, verifier: 'v', returnUrl: '/' }))}`;
        const ok = await fetch(`${base}/api/callback?code=code-${B}&state=${state}`, { headers: { cookie: oauthCookie }, redirect: 'manual' });
        assert.equal(ok.status, 302);
        assert.ok((ok.headers.get('set-cookie') || '').includes('ml_session='));
        assert.ok(kv.get(`meli_oauth_token_v2:${B}`));
        kv.reset();
        const bad = await fetch(`${base}/api/callback?code=code-333&state=${state}`, { headers: { cookie: oauthCookie }, redirect: 'manual' });
        assert.ok((bad.headers.get('location') || '').includes('not_allowed'));
        assert.ok(!(bad.headers.get('set-cookie') || '').includes('ml_session='));
        assert.equal(kv.writes().length, 0);
    });
});
