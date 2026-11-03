import * as z from 'zod/v4';

/** Reglas que el esquema zod no puede imponer: se revisan en código sobre lo que devuelve Claude. */
export const MAX_TITLE_CHARS = 60;
export const MAX_TITLES = 3;
export const MAX_IDEAS = 5;
/** Cargas masivas: copias por tanda (la misma constante limita el front). */
export const MIN_BULK_COPIES = 1;
export const MAX_BULK_COPIES = 20;

export const BulkTitlesSchema = z.object({
    titles: z.array(z.object({ title: z.string(), feature: z.string() })),
});
export type BulkTitlesOut = z.infer<typeof BulkTitlesSchema>;

// ---------------- Esquemas de salida estructurada ----------------
export const SuggestSchema = z.object({
    titles: z.array(z.object({ title: z.string(), reason: z.string() })),
    description: z.object({ text: z.string(), reason: z.string() }),
    checks: z.array(z.string()),
});
export type SuggestOut = z.infer<typeof SuggestSchema>;

export const IdeasSchema = z.object({
    ideas: z.array(z.object({
        title: z.string(),
        kind: z.enum(['tamaño', 'color', 'pack', 'relacionado', 'otro']),
        source_item_id: z.string(),
        data_behind: z.string(),
        confirm_stock: z.array(z.string()),
    })),
});
export type IdeasOut = z.infer<typeof IdeasSchema>;

// ---------------- Detección de contenido no permitido ----------------
const URL_RE = /(https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(com|mx|net|org|io|co|app|shop|store)\b(\/\S*)?/i;
const HTML_RE = /<\/?[a-z][^>]*>|&[a-z]+;|&#\d+;/i;
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i;
// 10 dígitos seguidos o con separadores (teléfono MX), o con lada +52
const PHONE_RE = /(\+?\d[\s().-]?){10,}/;
const SOCIAL_RE = /\b(whats\s?app|wasap|telegram|facebook|instagram|messenger)\b/i;
const SUPERLATIVE_RE = /\b(el mejor|la mejor|los mejores|las mejores|#1|número 1|numero 1|el más barato|el mas barato|garantizado|100% original|milagroso|el único|la única)\b/i;

export type DescFlag = 'links' | 'html' | 'phone' | 'email' | 'contact' | 'superlatives' | 'empty';

export function descriptionFlags(text: string): DescFlag[] {
    const flags: DescFlag[] = [];
    const t = String(text ?? '');
    if (!t.trim()) flags.push('empty');
    if (URL_RE.test(t)) flags.push('links');
    if (HTML_RE.test(t)) flags.push('html');
    if (PHONE_RE.test(t.replace(/\$\s?[\d.,]+/g, ''))) flags.push('phone');
    if (EMAIL_RE.test(t)) flags.push('email');
    if (SOCIAL_RE.test(t)) flags.push('contact');
    if (SUPERLATIVE_RE.test(t)) flags.push('superlatives');
    return flags;
}

export const FLAG_TEXT: Record<DescFlag, string> = {
    links: 'contiene enlaces o direcciones web',
    html: 'contiene HTML',
    phone: 'parece contener un teléfono',
    email: 'contiene un correo',
    contact: 'menciona un canal de contacto externo',
    superlatives: 'usa superlativos o promesas que ML puede rechazar',
    empty: 'está vacía',
};

export type TitleDrop = 'too_long' | 'empty' | 'contact' | 'superlatives' | 'duplicate';

/** Títulos: se descartan los de más de 60 caracteres, vacíos, con contacto/enlaces o superlativos, y repetidos. */
export function filterTitles<T extends { title: string }>(list: T[]): { kept: T[]; dropped: { title: string; why: TitleDrop }[] } {
    const kept: T[] = [];
    const dropped: { title: string; why: TitleDrop }[] = [];
    const seen = new Set<string>();
    for (const x of list) {
        const title = String(x.title ?? '').replace(/\s+/g, ' ').trim();
        let why: TitleDrop | null = null;
        if (!title) why = 'empty';
        else if (title.length > MAX_TITLE_CHARS) why = 'too_long';
        else if (URL_RE.test(title) || HTML_RE.test(title) || EMAIL_RE.test(title) || PHONE_RE.test(title) || SOCIAL_RE.test(title)) why = 'contact';
        else if (SUPERLATIVE_RE.test(title)) why = 'superlatives';
        else if (seen.has(title.toLowerCase())) why = 'duplicate';
        if (why) { dropped.push({ title, why }); continue; }
        seen.add(title.toLowerCase());
        kept.push({ ...x, title } as T);
    }
    return { kept, dropped };
}

// ---------------- Cercanía entre títulos (evita proponer "el mismo producto con otro título") ----------------
const STOP = new Set(['de', 'la', 'el', 'los', 'las', 'y', 'para', 'con', 'sin', 'en', 'por', 'un', 'una', 'del', 'al', 'a', 'o']);
export const titleTokens = (t: string): Set<string> =>
    new Set(String(t).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter(w => w && !STOP.has(w)));

export function titleSimilarity(a: string, b: string): number {
    const A = titleTokens(a), B = titleTokens(b);
    if (!A.size || !B.size) return 0;
    let inter = 0;
    A.forEach(w => { if (B.has(w)) inter++; });
    return inter / (A.size + B.size - inter);
}

/** Jaccard desde el que dos títulos se consideran el mismo. */
export const NEAR_DUPLICATE_SIMILARITY = 0.9;
/** Palabras de relleno: agregarlas o quitarlas no crea un producto distinto. */
const FILLER = new Set(['nuevo', 'nueva', 'nuevos', 'nuevas', 'original', 'oferta', 'envio', 'gratis', 'premium', 'calidad', 'promocion', 'hoy', 'excelente', 'barato', 'barata', 'full', 'mx', 'mexico']);

/**
 * Segunda línea de defensa (la primera es el prompt): el título de la idea es una copia cosmética de uno existente
 * si no aporta ninguna palabra con contenido que el otro no tenga (solo reordena, quita o agrega relleno),
 * o si es casi idéntico. Una variante real (otro color, talla, pack) siempre agrega una palabra nueva.
 */
export function isCosmeticCopy(idea: string, existing: string): boolean {
    const I = titleTokens(idea), E = titleTokens(existing);
    if (!I.size || !E.size) return false;
    const added = [...I].filter(w => !E.has(w) && !FILLER.has(w));
    return added.length === 0 || titleSimilarity(idea, existing) >= NEAR_DUPLICATE_SIMILARITY;
}

// ---------------- Cargas masivas: hechos que no constan en la publicación ----------------
const norm = (t: string): string => String(t).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/**
 * Números del título (medidas, cantidades, modelos) que no aparecen en los datos de la publicación.
 * Es una red de seguridad barata contra datos inventados: no demuestra que el resto sea cierto.
 */
export function numbersNotInSource(title: string, corpus: string): string[] {
    const hay = norm(corpus);
    const nums = norm(title).match(/\d+(?:[.,]\d+)?/g) ?? [];
    return nums.filter(n => !new RegExp(`(^|[^0-9])${n.replace(/[.,]/g, '[.,]')}($|[^0-9])`).test(hay));
}
