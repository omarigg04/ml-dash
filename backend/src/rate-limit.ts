import type { Request, RequestHandler } from 'express';
import { rateLimit, ipKeyGenerator, Store, ClientRateLimitInfo, Options } from 'express-rate-limit';
import { currentUid, hasAccountContext } from './auth/context';
import { storeDecr, storeIncr } from './ai/kvstore';

/**
 * Límites por minuto. Los contadores en memoria son por instancia de Vercel, así que frenan bucles y ráfagas
 * desde un mismo origen, pero no un ataque repartido entre instancias. Las escrituras sí se cuentan en KV.
 *
 * Los límites de cuenta dejan pasar las acciones en lote de la app (3 peticiones en paralelo).
 */
export const RATE_LIMITS = {
    anonymous: 60,      // por IP, sin sesión
    login: 20,          // por IP, /api/auth y /api/callback (el callback llama a ML)
    account: 600,       // por cuenta, cualquier método
    accountWrites: 300, // por cuenta, compartido entre instancias
};

const WINDOW_MS = 60_000;
const LOGIN_PATHS = new Set(['/api/auth', '/api/callback']);
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Ventana fija en KV. La clave incluye la ventana: si falla un EXPIRE, el contador viejo ya no bloquea a nadie. */
export class KvWindowStore implements Store {
    readonly localKeys = false;
    private windowMs = WINDOW_MS;

    constructor(private readonly now: () => number = Date.now) {}

    init(options: Options): void { this.windowMs = options.windowMs; }

    private window(): number { return Math.floor(this.now() / this.windowMs); }
    private key(key: string, window: number): string { return `rate_write:${key}:${window}`; }

    async increment(key: string): Promise<ClientRateLimitInfo> {
        const window = this.window();
        const totalHits = await storeIncr(this.key(key, window), Math.ceil((this.windowMs * 2) / 1000));
        return { totalHits, resetTime: new Date((window + 1) * this.windowMs) };
    }

    async decrement(key: string): Promise<void> { await storeDecr(this.key(key, this.window())); }

    async resetKey(): Promise<void> { /* la ventana caduca sola */ }
}

const limiter = (options: Partial<Options>): RequestHandler => rateLimit({
    windowMs: WINDOW_MS,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // Mismo formato de error que el resto de la API: la app muestra `error` en las acciones en lote
    handler: (_req, res) => {
        res.status(429).json({
            error: 'Demasiadas peticiones. Espera un minuto e inténtalo de nuevo.',
            code: 'RATE_LIMITED',
            status: 429,
            causes: [],
        });
    },
    ...options,
});

const ipKey = (req: Request): string => ipKeyGenerator(req.ip || '');

/** Antes de la autenticación: solo cuenta peticiones sin sesión válida. */
export const anonymousLimiters = (hasSession: (req: Request) => boolean): RequestHandler[] => [
    limiter({
        limit: RATE_LIMITS.anonymous,
        keyGenerator: ipKey,
        skip: req => hasSession(req),
    }),
    limiter({
        limit: RATE_LIMITS.login,
        keyGenerator: ipKey,
        skip: req => hasSession(req) || !LOGIN_PATHS.has(req.path),
    }),
];

/** Después de la autenticación: se cuenta por cuenta para que una tienda no gaste el límite de la otra. */
export const accountLimiters = (store: Store = new KvWindowStore()): RequestHandler[] => [
    limiter({
        limit: RATE_LIMITS.account,
        keyGenerator: () => currentUid(),
        skip: () => !hasAccountContext(),
    }),
    limiter({
        limit: RATE_LIMITS.accountWrites,
        store,
        // Si KV falla, un límite no debe impedir trabajar: queda el contador en memoria
        passOnStoreError: true,
        keyGenerator: () => currentUid(),
        skip: req => READ_METHODS.has(req.method) || !hasAccountContext(),
    }),
];
