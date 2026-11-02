// Helpers de seguridad compartidos: validación de ids y logs sin secretos

export const ITEM_ID_RE = /^MLM\d+$/;
export const CATEGORY_ID_RE = /^MLM\d+$/;
export const ORDER_ID_RE = /^\d+$/;
export const SHIPMENT_ID_RE = /^\d+$/;
export const USER_ID_RE = /^\d+$/;

/** Resumen seguro de un error (nunca el objeto completo: AxiosError incluye Authorization y client_secret). */
export const safeError = (error: any): string => {
    const status = error?.response?.status;
    const data = error?.response?.data;
    const detail = data ? (typeof data === 'string' ? data.slice(0, 300) : JSON.stringify(data).slice(0, 300)) : '';
    return [status ? `status=${status}` : '', error?.code || '', error?.message || '', detail]
        .filter(Boolean)
        .join(' | ');
};
