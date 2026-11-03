/** Lógica pura de Cargas masivas (sin Angular): títulos, avisos y pasos de validación. */

export const MAX_COPIES = 20;
export const MIN_COPIES = 1;
export const MAX_TITLE = 60;
/** Jaccard desde el que dos títulos se consideran "casi el mismo" (aviso, nunca bloqueo). */
export const SIMILAR_TITLE = 0.9;
/** Pausa entre un envío y el siguiente al publicar (se envía de uno en uno desde el navegador). */
export const PUBLISH_GAP_MS = 1500;
export const VALIDATE_CONCURRENCY = 2;
/** Aviso que ML devuelve a veces como error y que, solo, no impide publicar (igual que en el formulario). */
export const IGNORABLE_ERROR_CODES = ['shipping.lost_me1_by_user'];

export const DUPLICATE_WARNING =
  'Mercado Libre indica que las publicaciones duplicadas no están permitidas y puede darlas de baja o sancionar la cuenta. Tú decides.';

export type RowStatus = 'pending' | 'publishing' | 'published' | 'error' | 'unconfirmed';

const STOP = new Set(['de', 'la', 'el', 'los', 'las', 'y', 'para', 'con', 'sin', 'en', 'por', 'un', 'una', 'del', 'al', 'a', 'o']);

const tokens = (t: string): Set<string> =>
  new Set(String(t).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter(w => w && !STOP.has(w)));

export function titleSimilarity(a: string, b: string): number {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) { return 0; }
  let inter = 0;
  A.forEach(w => { if (B.has(w)) { inter++; } });
  return inter / (A.size + B.size - inter);
}

export const normTitle = (t: string): string => String(t ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/** Avisos de título por fila (índice -> textos). Nunca bloquean. */
export function titleWarnings(titles: string[], source: string): string[][] {
  const counts = new Map<string, number>();
  titles.forEach(t => { const k = normTitle(t); if (k) { counts.set(k, (counts.get(k) || 0) + 1); } });
  return titles.map(t => {
    const out: string[] = [];
    const k = normTitle(t);
    if (!k) { return out; }
    if ((counts.get(k) || 0) > 1) { out.push('Título idéntico al de otra fila.'); }
    if (k === normTitle(source)) { out.push('Igual al título del original.'); }
    else if (titleSimilarity(t, source) >= SIMILAR_TITLE) { out.push('Casi igual al título del original.'); }
    return out;
  });
}

/** Separa los errores de ML que no impiden publicar (p. ej. shipping.lost_me1_by_user) de los reales. */
export function splitIssues<T extends { code: string }>(errors: T[], warnings: T[]): { errors: T[]; warnings: T[] } {
  const ignorable = errors.filter(e => IGNORABLE_ERROR_CODES.includes(e.code));
  return { errors: errors.filter(e => !IGNORABLE_ERROR_CODES.includes(e.code)), warnings: [...warnings, ...ignorable] };
}

/** Ejecuta `fn` sobre cada elemento con como máximo `limit` en paralelo; `shouldStop` corta antes de iniciar el siguiente. */
export async function runPool<T>(items: T[], limit: number, fn: (x: T) => Promise<void>, shouldStop: () => boolean = () => false): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length && !shouldStop()) {
      const item = items[next++];
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export const clampCopies = (n: unknown): number => {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v)) { return MIN_COPIES; }
  return Math.min(MAX_COPIES, Math.max(MIN_COPIES, v));
};
