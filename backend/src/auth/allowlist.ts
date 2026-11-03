// Lista de cuentas de MercadoLibre autorizadas. Única fuente de verdad para oauth.ts, session.ts y el contexto.
// ALLOWED_ML_USER_ID: ids separados por comas ("123" o "123, 456"). Vacío o ausente = nadie.

export const parseAllowedIds = (raw: string | undefined | null): string[] =>
    (raw || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);

export const getAllowedIds = (): string[] => parseAllowedIds(process.env['ALLOWED_ML_USER_ID']);

/** Comparación exacta del id como cadena. Falla cerrado: lista vacía o id ausente = false. */
export const isAllowedId = (uid: unknown): boolean => {
    if (typeof uid !== 'number' && typeof uid !== 'string') return false;
    const id = String(uid);
    if (!id) return false;
    return getAllowedIds().includes(id);
};
