export interface Publication {
  id: string;
  title: string;
  price: number;
  available_quantity: number;
  sold_quantity?: number;
  status: string;
  thumbnail: string | null;
  listing_type_id: string;
  condition: string;
  permalink: string;
  date_created: string;
  last_updated: string;
  fullData?: any;
  /** undefined = cargando, null = ML falló para este item, número = visitas reales */
  visits?: number | null;
}

export interface PagingInfo { total: number; offset: number; limit: number; }

export type Tone = 'success' | 'warning' | 'info' | 'error' | 'off';

// Estados de publicación traducidos; lo desconocido se muestra tal cual con tono neutro.
export const ITEM_STATUS: Record<string, { label: string; tone: Tone }> = {
  active: { label: 'Activa', tone: 'success' },
  paused: { label: 'Pausada', tone: 'warning' },
  closed: { label: 'Finalizada', tone: 'off' },
  under_review: { label: 'En revisión', tone: 'info' },
  inactive: { label: 'Inactiva', tone: 'off' },
};

export const LISTING_TYPES: Record<string, string> = {
  gold_special: 'Clásica',
  gold_pro: 'Premium',
  free: 'Gratuita',
};

export const STATUS_OPTIONS = [
  { value: '', label: 'Todas' },
  { value: 'active', label: 'Activas' },
  { value: 'paused', label: 'Pausadas' },
  { value: 'closed', label: 'Finalizadas' },
  { value: 'under_review', label: 'En revisión' },
  { value: 'inactive', label: 'Inactivas' },
];

/** Órdenes que el backend soporta de verdad (GET /api/items?sort=). */
export const SORT_OPTIONS = [
  { value: 'sales_desc', label: 'Por ventas' },
  { value: 'sales_asc', label: 'Menos vendidos' },
  { value: 'date_desc', label: 'Más recientes' },
  { value: 'date_asc', label: 'Más antiguos' },
  { value: 'price_desc', label: 'Mayor precio' },
  { value: 'price_asc', label: 'Menor precio' },
  { value: 'stock_asc', label: 'Menor stock' },
  { value: 'stock_desc', label: 'Mayor stock' },
  { value: 'title_asc', label: 'Título A-Z' },
  { value: 'title_desc', label: 'Título Z-A' },
  { value: 'revenue_desc', label: 'Mayor ingreso' },
  { value: 'revenue_asc', label: 'Menor ingreso' },
];
/** Órdenes que solo se eligen desde el encabezado de la columna. */
export const HEADER_SORT_OPTIONS = [
  { value: 'status_asc', label: 'Estado A-Z' },
  { value: 'status_desc', label: 'Estado Z-A' },
  { value: 'visits_desc', label: 'Más visitas (esta página)' },
  { value: 'visits_asc', label: 'Menos visitas (esta página)' },
  { value: 'conv_desc', label: 'Mayor conversión (esta página)' },
  { value: 'conv_asc', label: 'Menor conversión (esta página)' },
];

export const LOW_STOCK = 20;

export const money = (v: number | null | undefined): string =>
  v == null ? '' : Number(v).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
export const intFmt = (v: number | null | undefined): string =>
  v == null ? '' : Number(v).toLocaleString('es-MX');
export const pctFmt = (v: number): string =>
  (v * 100).toLocaleString('es-MX', { maximumFractionDigits: 1 }) + '%';
/** Conversión = vendidos / visitas, solo con visitas reales > 0. */
// sold_quantity es de toda la vida, pero ML solo conserva parte del historial de visitas.
// Si hay más ventas que visitas los periodos no son comparables: no se muestra un % imposible.
export const conversion = (p: Publication): number | null => {
  const sold = p.sold_quantity ?? 0;
  if (p.visits == null || p.visits <= 0 || sold > p.visits) return null;
  return sold / p.visits;
};
/** Ingreso aproximado: precio actual × unidades vendidas. */
export const revenue = (p: Publication): number => (p.price || 0) * (p.sold_quantity || 0);

/** Mensaje legible de un error HTTP del backend (cause[] de ML primero). */
export function errorReason(err: any): string {
  const e = err?.error;
  const causes: string[] = (e?.causes || []).map((c: any) => c.message || c.code).filter(Boolean);
  if (causes.length) return causes.join(' · ');
  return e?.error || err?.message || 'Error desconocido';
}

/** Ejecuta `fn` sobre `items` con a lo más `limit` en paralelo; un fallo no detiene a los demás. */
export async function runPool<T>(items: T[], limit: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) {
      try { await fn(items[i], i); } catch { /* cada fn registra su propio error */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
