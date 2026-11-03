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
