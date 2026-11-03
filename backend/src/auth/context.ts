import { AsyncLocalStorage } from 'async_hooks';
import { getAllowedIds, isAllowedId } from './allowlist';

// Cuenta (uid de ML) de la petición en curso. Se fija en el middleware de autenticación de api/index.ts
// y mlAuth la lee: así las rutas no cambian y NUNCA hay una cuenta por defecto.
interface AccountStore { uid: string; }
const storage = new AsyncLocalStorage<AccountStore>();

export class NoAccountContextError extends Error {
    constructor() {
        super('No account in request context');
    }
}

export const runWithAccount = <T>(uid: number | string, fn: () => T): T => storage.run({ uid: String(uid) }, fn);

/** Uid de la petición actual. Lanza si no hay contexto o si la cuenta ya no está en la lista permitida. */
export const currentUid = (): string => {
    const store = storage.getStore();
    if (!store || !isAllowedId(store.uid)) throw new NoAccountContextError();
    return store.uid;
};

export const hasAccountContext = (): boolean => {
    try { currentUid(); return true; } catch { return false; }
};

/**
 * Callbacks de emisores de eventos (multer/busboy) pueden ejecutarse fuera del contexto de la petición.
 * Captura la cuenta ahora y devuelve un envoltorio que restablece ese contexto al llamar al callback.
 */
export const bindToCurrentAccount = <A extends any[], R>(fn: (...args: A) => R): ((...args: A) => R) => {
    const store = storage.getStore();
    if (!store) return fn;
    return (...args: A) => storage.run(store, () => fn(...args));
};

/** Cuenta del modo local sin autenticación (LOCAL_DEV_NO_AUTH, nunca en producción): LOCAL_DEV_UID, si no la primera permitida. */
export const localDevUid = (): string | null => process.env['LOCAL_DEV_UID']?.trim() || getAllowedIds()[0] || null;
