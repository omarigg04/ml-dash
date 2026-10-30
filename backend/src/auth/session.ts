import * as crypto from 'crypto';
import { Request, Response } from 'express';

export const SESSION_COOKIE = 'ml_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 días

interface SessionPayload {
    uid: number;
    exp: number;
}

// SESSION_SECRET is optional: falls back to a key derived from APP_SECRET
const secret = (): string =>
    process.env['SESSION_SECRET'] ||
    crypto.createHash('sha256').update(`session:${process.env['APP_SECRET'] || ''}`).digest('hex');

const sign = (data: string): string =>
    crypto.createHmac('sha256', secret()).update(data).digest('base64url');

export const getCookie = (req: Request, name: string): string | undefined => {
    const raw = (req.headers.cookie || '')
        .split(';')
        .map(c => c.trim())
        .find(c => c.startsWith(`${name}=`));
    return raw ? decodeURIComponent(raw.slice(name.length + 1)) : undefined;
};

export const createSession = (res: Response, uid: number): void => {
    const payload: SessionPayload = { uid, exp: Date.now() + SESSION_TTL_MS };
    const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
    res.cookie(SESSION_COOKIE, `${data}.${sign(data)}`, {
        httpOnly: true,
        secure: !!process.env['VERCEL'],
        sameSite: 'lax',
        maxAge: SESSION_TTL_MS,
    });
};

export const getSession = (req: Request): SessionPayload | null => {
    const value = getCookie(req, SESSION_COOKIE);
    if (!value) return null;

    const [data, signature] = value.split('.');
    if (!data || !signature) return null;

    const expected = sign(data);
    if (signature.length !== expected.length ||
        !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
        return null;
    }

    try {
        const payload = JSON.parse(Buffer.from(data, 'base64url').toString()) as SessionPayload;
        return payload.exp > Date.now() ? payload : null;
    } catch {
        return null;
    }
};

export const clearSession = (res: Response): void => {
    res.clearCookie(SESSION_COOKIE);
};
