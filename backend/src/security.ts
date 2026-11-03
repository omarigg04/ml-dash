// Helpers de seguridad compartidos: validación de ids y logs sin secretos

export const ITEM_ID_RE = /^MLM\d+$/;
export const CATEGORY_ID_RE = /^MLM\d+$/;
export const ORDER_ID_RE = /^\d+$/;
export const SHIPMENT_ID_RE = /^\d+$/;
export const USER_ID_RE = /^\d+$/;

/**
 * Ruta de regreso tras el login: solo rutas relativas del mismo sitio.
 * Los navegadores tratan "\" como "/", así que "/\evil.com" saldría a otro dominio.
 */
export const safeReturnPath = (value: unknown): string => {
    if (typeof value !== 'string' || !value.startsWith('/') || /[\\\u0000-\u001f\u007f]/.test(value)) {
        return '/';
    }
    try {
        const base = 'https://app.invalid';
        return new URL(value, base).origin === base ? value : '/';
    } catch {
        return '/';
    }
};

/** Resumen seguro de un error (nunca el objeto completo: AxiosError incluye Authorization y client_secret). */
export const safeError = (error: any): string => {
    const status = error?.response?.status;
    const data = error?.response?.data;
    const detail = data ? (typeof data === 'string' ? data.slice(0, 300) : JSON.stringify(data).slice(0, 300)) : '';
    return [status ? `status=${status}` : '', error?.code || '', error?.message || '', detail]
        .filter(Boolean)
        .join(' | ');
};

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Defensa CSRF explícita para métodos que cambian estado (incluye logout y multipart).
 * - Sec-Fetch-Site: same-origin -> permitido (el navegador lo garantiza).
 * - Origin presente -> permitido solo si su host coincide con el de la petición
 *   (x-forwarded-host en Vercel) o si está en la lista blanca.
 * - Sin ninguna de las dos cabeceras -> permitido: un navegador moderno siempre envía al menos
 *   una en peticiones POST/PUT/DELETE, así que esto solo deja pasar clientes que no son
 *   navegadores (curl, servidores), que no usan la cookie de sesión de forma ambiental.
 * - Cualquier otro caso -> 403 CSRF.
 */
export const csrfProtection = (allowedOrigins: Set<string>, trustForwardedHost: boolean) =>
    (req: any, res: any, next: any) => {
        if (SAFE_METHODS.has(req.method)) return next();

        const site = req.headers['sec-fetch-site'];
        if (site === 'same-origin') return next();

        const origin = req.headers['origin'] as string | undefined;
        if (!site && !origin) return next();

        if (origin) {
            if (allowedOrigins.has(origin.replace(/\/+$/, ''))) return next();
            const forwarded = trustForwardedHost ? req.headers['x-forwarded-host'] : undefined;
            const host = String(forwarded || req.headers['host'] || '').split(',')[0].trim().toLowerCase();
            try {
                if (host && new URL(origin).host.toLowerCase() === host) return next();
            } catch { /* Origin inválido o "null": se rechaza */ }
        }

        res.status(403).json({ error: 'Forbidden', code: 'CSRF_BLOCKED', message: 'Cross-site request blocked' });
    };
