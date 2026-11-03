import * as crypto from 'crypto';
import { Request, Response } from 'express';
import { isAllowedId } from './allowlist';

export const SESSION_COOKIE = 'ml_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 días

interface SessionPayload {
    uid: number;
    exp: number;
    /** Versión de sesión (SESSION_VERSION). Ausente = '' para no invalidar cookies anteriores. */
    v?: string;
}

// Revocación sin almacén: rotar SESSION_SECRET invalida TODAS las sesiones;
// subir SESSION_VERSION (variable de entorno) hace lo mismo sin tocar el secreto.
const sessionVersion = (): string => process.env['SESSION_VERSION'] || '';

let missingSecretLogged = false;

// SESSION_SECRET preferido; respaldo derivado de APP_SECRET. Sin ninguno de los dos
// no hay clave: nunca se firma con una constante pública (derivada de cadena vacía).
const secret = (): string | null => {
    if (process.env['SESSION_SECRET']) return process.env['SESSION_SECRET'];
    const appSecret = process.env['APP_SECRET'];
    if (appSecret) {
        return crypto.createHash('sha256').update(`session:${appSecret}`).digest('hex');
    }
    if (!missingSecretLogged) {
        missingSecretLogged = true;
        console.error('[security] Neither SESSION_SECRET nor APP_SECRET is set: sessions are disabled');
    }
    return null;
};

const sign = (data: string): string | null => {
    const key = secret();
    return key ? crypto.createHmac('sha256', key).update(data).digest('base64url') : null;
};

// Misma lista que oauth.ts (allowlist.ts). Falla cerrado: un id retirado de la lista invalida su sesión.
const isAllowedUser = (uid: unknown): boolean => typeof uid === 'number' && isAllowedId(uid);

export const getCookie = (req: Request, name: string): string | undefined => {
    const raw = (req.headers.cookie || '')
        .split(';')
        .map(c => c.trim())
        .find(c => c.startsWith(`${name}=`));
    if (!raw) return undefined;
    try {
        return decodeURIComponent(raw.slice(name.length + 1));
    } catch {
        return undefined; // codificación inválida: se trata como cookie ausente
    }
};

export const createSession = (res: Response, uid: number): void => {
    const payload: SessionPayload = { uid, exp: Date.now() + SESSION_TTL_MS };
    const version = sessionVersion();
    if (version) payload.v = version;
    const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = sign(data);
    if (!signature) return; // sin secreto no se crean sesiones
    res.cookie(SESSION_COOKIE, `${data}.${signature}`, {
        httpOnly: true,
        secure: !!process.env['VERCEL'] || process.env['NODE_ENV'] === 'production',
        sameSite: 'lax',
        maxAge: SESSION_TTL_MS,
    });
};

export const getSession = (req: Request): SessionPayload | null => {
    const value = getCookie(req, SESSION_COOKIE);
    if (!value) return null;

    const parts = value.split('.');
    if (parts.length !== 2) return null;
    const [data, signature] = parts;
    if (!data || !signature) return null;

    const expected = sign(data);
    if (!expected) return null;
    if (signature.length !== expected.length ||
        !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
        return null;
    }

    try {
        const payload = JSON.parse(Buffer.from(data, 'base64url').toString()) as SessionPayload;
        if (!payload || typeof payload !== 'object') return null;
        if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || payload.exp <= Date.now()) return null;
        if (!isAllowedUser(payload.uid)) return null;
        if ((payload.v ?? '') !== sessionVersion()) return null;
        return payload;
    } catch {
        return null;
    }
};

export const clearSession = (res: Response): void => {
    res.clearCookie(SESSION_COOKIE);
};
