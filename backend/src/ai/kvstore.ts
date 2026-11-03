import { kvRestApi, isServerless } from '../auth/oauth';

/**
 * Almacén clave-valor de las funciones de IA (límite diario, cachés, cambios aplicados).
 * Usa el mismo helper REST de KV que los tokens (oauth.ts). Sin KV y fuera de serverless (desarrollo local)
 * usa memoria del proceso; en serverless sin KV, o si KV falla, lanza StoreUnavailableError: falla cerrado.
 */
export class StoreUnavailableError extends Error {
    constructor(msg = 'Almacenamiento (KV) no disponible') { super(msg); }
}

const mem = new Map<string, { v: string; exp: number | null }>();
export const __resetMemoryStoreForTests = () => mem.clear();

const useMemory = (): boolean => {
    if (process.env['KV_REST_API_URL']) return false;
    if (isServerless()) throw new StoreUnavailableError('KV_REST_API_URL no está configurado');
    return true;
};

const kv = async (cmd: any[]): Promise<any> => {
    try { return await kvRestApi('POST', cmd); }
    catch (e: any) { throw new StoreUnavailableError(e?.message || 'KV error'); }
};

const memGet = (key: string): string | null => {
    const e = mem.get(key);
    if (!e) return null;
    if (e.exp !== null && e.exp <= Date.now()) { mem.delete(key); return null; }
    return e.v;
};

export async function storeGet<T = any>(key: string): Promise<T | null> {
    const raw = useMemory() ? memGet(key) : await kv(['GET', key]);
    if (raw === null || raw === undefined) return null;
    try { return (typeof raw === 'string' ? JSON.parse(raw) : raw) as T; } catch { return null; }
}

export async function storeSet(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    const json = JSON.stringify(value);
    if (useMemory()) { mem.set(key, { v: json, exp: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null }); return; }
    await kv(ttlSeconds ? ['SET', key, json, 'EX', ttlSeconds] : ['SET', key, json]);
}

/** Contador atómico (INCR). Fija la caducidad al crearse. */
export async function storeIncr(key: string, ttlSeconds: number): Promise<number> {
    if (useMemory()) {
        const cur = Number(memGet(key) ?? 0) + 1;
        const prev = mem.get(key);
        mem.set(key, { v: String(cur), exp: prev?.exp ?? Date.now() + ttlSeconds * 1000 });
        return cur;
    }
    const n = Number(await kv(['INCR', key]));
    if (n === 1) await kv(['EXPIRE', key, ttlSeconds]);
    return n;
}

export async function storeDecr(key: string): Promise<void> {
    if (useMemory()) {
        const e = mem.get(key);
        if (e) mem.set(key, { v: String(Math.max(0, Number(e.v) - 1)), exp: e.exp });
        return;
    }
    await kv(['DECR', key]);
}

export async function storeCount(key: string): Promise<number> {
    const raw = useMemory() ? memGet(key) : await kv(['GET', key]);
    const n = Number(raw ?? 0);
    return Number.isFinite(n) ? n : 0;
}
