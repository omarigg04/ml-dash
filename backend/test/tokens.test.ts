import { A, B, kv, ml, makeToken, freshApp, resetAll, seedBoth } from './support';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const LEGACY = 'meli_oauth_token_v2';
const key = (uid: number) => `${LEGACY}:${uid}`;
const OLD = Date.now() - 10 * 3600_000; // expirado (expires_in 6 h)

beforeEach(resetAll);

const putToken = (k: string, uid: number, over: Record<string, any> = {}, register = true) => {
    const t = makeToken(uid, over);
    kv.put(k, t);
    if (register) ml.register(uid, t.access_token, t.refresh_token);
    return t;
};

test('cada cuenta usa su propio token, incluso con peticiones concurrentes intercaladas', async () => {
    seedBoth();
    ml.delayMs = 5;
    const { mlAuth, context } = freshApp();
    const jobs = Array.from({ length: 60 }, (_, i) => {
        const uid = i % 2 ? A : B;
        return context.runWithAccount(uid, async () => {
            await new Promise(r => setTimeout(r, Math.random() * 10));
            const token = await mlAuth.getToken();
            await new Promise(r => setImmediate(r));
            return { uid, token, again: await mlAuth.getToken() };
        });
    });
    for (const r of await Promise.all(jobs)) {
        assert.equal(r.token, `AT-${r.uid}-0`);
        assert.equal(r.again, `AT-${r.uid}-0`);
    }
});

test('sin cuenta en el contexto getToken lanza (nunca hay token por defecto)', async () => {
    seedBoth();
    const { mlAuth } = freshApp();
    await assert.rejects(() => mlAuth.getToken(), /No account/);
    await assert.rejects(() => mlAuth.isConnected(), /No account/);
    await assert.rejects(() => mlAuth.refreshAccessToken(), /No account/);
    await assert.rejects(() => mlAuth.clearTokens(), /No account/);
    assert.equal(kv.writes().length, 0);
});

test('una cuenta retirada de la lista no obtiene token aunque esté en el contexto', async () => {
    seedBoth();
    const { mlAuth, context } = freshApp();
    await assert.rejects(() => context.runWithAccount(333, () => mlAuth.getToken()), /No account/);
    process.env['ALLOWED_ML_USER_ID'] = String(B);
    try {
        await assert.rejects(() => context.runWithAccount(A, () => mlAuth.getToken()), /No account/);
        assert.equal(await context.runWithAccount(B, () => mlAuth.getToken()), `AT-${B}-0`);
    } finally { process.env['ALLOWED_ML_USER_ID'] = `${A},${B}`; }
});

test('el refresh de una cuenta no toca a la otra (y es de un solo vuelo por cuenta)', async () => {
    putToken(key(A), A, { created_at: OLD });
    putToken(key(B), B);
    const { mlAuth, context } = freshApp();
    ml.delayMs = 5;
    const res = await Promise.all([
        ...Array.from({ length: 8 }, () => context.runWithAccount(A, () => mlAuth.getToken())),
        ...Array.from({ length: 8 }, () => context.runWithAccount(B, () => mlAuth.getToken())),
    ]);
    assert.ok(res.slice(0, 8).every(t => t.startsWith(`AT-${A}-r`) && t === res[0]));
    assert.ok(res.slice(8).every(t => t === `AT-${B}-0`));
    assert.equal(ml.refreshCalls().length, 1);
    const writtenKeys = kv.writes().map(w => w.key);
    assert.ok(writtenKeys.every(k => k === key(A)), `solo debe escribirse la clave de A: ${writtenKeys}`);
    assert.equal(kv.get(key(B)).access_token, `AT-${B}-0`);
});

test('recuperación de "refresh token already used" es por cuenta', async () => {
    putToken(key(A), A, { created_at: OLD }, false);   // ML ya no acepta este refresh token (lo usó otra instancia)
    putToken(key(B), B);
    const { mlAuth, context } = freshApp();
    // Mientras A refresca, "otra instancia" deja en KV el token rotado de A
    ml.onRefresh = () => {
        kv.put(key(A), makeToken(A, { access_token: 'AT-A-rotated', refresh_token: 'RT-A-rotated' }));
    };
    assert.equal(await context.runWithAccount(A, () => mlAuth.getToken()), 'AT-A-rotated');
    assert.equal(kv.get(key(B)).access_token, `AT-${B}-0`);
    assert.ok(!kv.writes().some(w => w.cmd === 'DEL'));
});

test('refresh revocado: solo se borran las claves de esa cuenta', async () => {
    putToken(key(A), A, { created_at: OLD }, false);   // ML no lo conoce: invalid_grant
    putToken(key(B), B);
    const { mlAuth, context } = freshApp();
    await assert.rejects(() => context.runWithAccount(A, () => mlAuth.getToken()), /Authorization expired/);
    assert.equal(kv.get(key(A)), null);
    assert.equal(kv.get(key(B)).access_token, `AT-${B}-0`);
    assert.equal(await context.runWithAccount(B, () => mlAuth.getToken()), `AT-${B}-0`);
});

test('refresh sin user_id en la respuesta de ML conserva el user_id existente', async () => {
    putToken(key(B), B, { created_at: OLD });
    ml.omitUserIdOnRefresh = true;
    const { mlAuth, context } = freshApp();
    await context.runWithAccount(B, () => mlAuth.getToken());
    assert.equal(kv.get(key(B)).user_id, B);
});

// ---------------- migración ----------------
const readFor = async (uid: number) => {
    const { mlAuth, context } = freshApp();
    kv.log = [];
    try { return await context.runWithAccount(uid, () => mlAuth.getToken()); }
    catch (e: any) { return `ERR:${e.message}`; }
};

test('migración: el token heredado del dueño se encuentra y la lectura no escribe en KV', async () => {
    putToken(LEGACY, A);
    assert.equal(await readFor(A), `AT-${A}-0`);
    assert.equal(kv.writes().length, 0);
});

test('migración: el token heredado NO sirve a otra cuenta', async () => {
    putToken(LEGACY, A);
    assert.match(String(await readFor(B)), /^ERR:No token available/);
    assert.equal(kv.writes().length, 0);
});

test('migración: heredado de otro usuario o sin user_id nunca se usa', async () => {
    putToken(LEGACY, B);                       // heredado dice B
    assert.match(String(await readFor(A)), /^ERR:No token available/);
    kv.reset();
    const t = makeToken(A); delete (t as any).user_id;
    kv.put(LEGACY, t); ml.register(A, t.access_token, t.refresh_token);
    assert.match(String(await readFor(A)), /^ERR:No token available/);
    assert.match(String(await readFor(B)), /^ERR:No token available/);
    assert.equal(kv.writes().length, 0);
});

test('migración: gana el más reciente entre clave por uid y heredada', async () => {
    putToken(key(A), A, { access_token: 'AT-A-perUid', refresh_token: 'RT-A-perUid', created_at: Date.now() - 1000 });
    putToken(LEGACY, A, { access_token: 'AT-A-legacy', refresh_token: 'RT-A-legacy', created_at: Date.now() });
    assert.equal(await readFor(A), 'AT-A-legacy');
    kv.reset(); ml.reset();
    putToken(key(A), A, { access_token: 'AT-A-perUid', refresh_token: 'RT-A-perUid', created_at: Date.now() });
    putToken(LEGACY, A, { access_token: 'AT-A-legacy', refresh_token: 'RT-A-legacy', created_at: Date.now() - 1000 });
    assert.equal(await readFor(A), 'AT-A-perUid');
    assert.equal(kv.writes().length, 0);
});

test('migración: clave por uid de otro usuario (user_id distinto) se rechaza', async () => {
    putToken(key(A), A, { user_id: B });
    assert.match(String(await readFor(A)), /^ERR:No token available/);
});

test('si KV falla al leer no se decide con datos parciales ni se escribe', async () => {
    putToken(LEGACY, A);
    kv.failReads = true;
    assert.match(String(await readFor(A)), /^ERR:No token available/);
    assert.equal(kv.writes().length, 0);
});

test('doble escritura: solo para el dueño del token heredado', async () => {
    putToken(LEGACY, A, { created_at: OLD });
    putToken(key(B), B, { created_at: OLD });
    const legacyBefore = kv.data.get(LEGACY);
    const { mlAuth, context } = freshApp();
    kv.log = [];
    // B refresca: el heredado es de A, no se toca
    await context.runWithAccount(B, () => mlAuth.getToken());
    assert.equal(kv.data.get(LEGACY), legacyBefore);
    assert.ok(kv.writes().every(w => w.key === key(B)));
    // A refresca: se escriben ambas claves con el mismo token y el heredado no se borra
    const tokenA = await context.runWithAccount(A, () => mlAuth.getToken());
    assert.equal(kv.get(LEGACY).access_token, tokenA);
    assert.equal(kv.get(key(A)).access_token, tokenA);
    assert.equal(kv.get(LEGACY).user_id, A);
    assert.ok(!kv.writes().some(w => w.cmd === 'DEL'));
});

test('login (callback sin contexto): guarda por uid, doble escritura solo para el dueño y rechaza ids no permitidos', async () => {
    putToken(LEGACY, A);
    const { mlAuth, oauth } = freshApp();
    kv.log = [];
    const tb = await mlAuth.getAccessToken('code-222');
    assert.equal(tb.user_id, B);
    assert.equal(kv.get(key(B)).access_token, tb.access_token);
    assert.equal(kv.get(LEGACY).user_id, A, 'el heredado del dueño no se pisa con el token de B');
    const ta = await mlAuth.getAccessToken('code-111');
    assert.equal(kv.get(key(A)).access_token, ta.access_token);
    assert.equal(kv.get(LEGACY).access_token, ta.access_token);
    kv.log = [];
    await assert.rejects(() => mlAuth.getAccessToken('code-333'), oauth.UserNotAllowedError);
    assert.equal(kv.writes().length, 0);
});
