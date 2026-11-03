import { SummaryRow, shortDay } from '../home/home-data';
import { satRetention } from '../shared/order-math';
import { Metrics, computeMetrics } from '../shared/sales-metrics';

/** Respuesta de GET /api/analytics/items (publicaciones + visitas reales por ventana). */
export interface AItem {
  id: string; title: string; price: number; available_quantity: number; sold_quantity: number;
  status: string; listing_type_id: string; permalink: string; date_created: string | null;
  free_shipping: boolean;
  /** Visitas en la ventana; null = ML no respondió para esta publicación (nunca 0) */
  visits: number | null;
  /** Visitas de los últimos 30 días; null igual que arriba */
  visits30: number | null;
}
export interface AItemsResponse {
  range: { from: string; to: string; last30From: string; today: string };
  items: AItem[];
  accountDaily: { date: string; total: number }[] | null;
  partial: boolean; visitsMissing: number; truncated: boolean;
  meta: { ms: number; mlCalls: number; cacheHits: number; items: number };
}

const DAY_MS = 86_400_000;
const pad = (n: number) => String(n).padStart(2, '0');
export const ymd = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const addDays = (day: string, n: number): string => new Date(Date.parse(day + 'T00:00:00Z') + n * DAY_MS).toISOString().slice(0, 10);
export const diffDays = (a: string, b: string): number => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY_MS);
export const eachDay = (a: string, b: string): string[] => { const out: string[] = []; for (let d = a; d <= b; d = addDays(d, 1)) out.push(d); return out; };

// ---------- Períodos (mismos 3 selectores que antes: 2 semanas / 2 meses / 2 bimestres) ----------
export type PeriodKey = '2weeks' | '2months' | '2bimesters';
export interface Span { from: string; to: string; name: string; }
export interface PeriodPair { cur: Span; prev: Span; groupBy: 'day' | 'week'; }

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function periodPair(key: PeriodKey, now = new Date()): PeriodPair {
  const y = now.getFullYear(), m = now.getMonth();
  if (key === '2weeks') {
    const today = ymd(now);
    return {
      cur: { from: addDays(today, -6), to: today, name: 'Esta semana' },
      prev: { from: addDays(today, -13), to: addDays(today, -7), name: 'Semana pasada' },
      groupBy: 'day'
    };
  }
  if (key === '2months') {
    const mName = (d: Date) => cap(d.toLocaleString('es-MX', { month: 'long' }));
    const d2 = new Date(y, m - 1, 1), d1 = new Date(y, m - 2, 1);
    return {
      cur: { from: ymd(d2), to: ymd(new Date(y, m, 0)), name: mName(d2) },
      prev: { from: ymd(d1), to: ymd(new Date(y, m - 1, 0)), name: mName(d1) },
      groupBy: 'day'
    };
  }
  const names = ['Ene-Feb', 'Mar-Abr', 'May-Jun', 'Jul-Ago', 'Sep-Oct', 'Nov-Dic'];
  const b2 = Math.floor(m / 2) - 1; // bimestre anterior completo (puede caer en el año pasado)
  const first = (bi: number) => new Date(y, bi * 2, 1);
  const last = (bi: number) => new Date(y, bi * 2 + 2, 0);
  const nm = (bi: number) => names[((bi % 6) + 6) % 6];
  return {
    cur: { from: ymd(first(b2)), to: ymd(last(b2)), name: nm(b2) },
    prev: { from: ymd(first(b2 - 1)), to: ymd(last(b2 - 1)), name: nm(b2 - 1) },
    groupBy: 'week'
  };
}

export const rowsIn = (rows: SummaryRow[], a: string, b: string): SummaryRow[] => rows.filter(r => r.day >= a && r.day <= b);
export const hasMissingShipping = (rows: SummaryRow[]): boolean => rows.some(r => r.listCost === null);

/** Métricas con la fórmula compartida; envios/real quedan en null si falta algún costo de envío (nunca $0). */
export interface KnownMetrics extends Omit<Metrics, 'real' | 'envios'> { real: number | null; envios: number | null; sat: number; }
export function metricsOf(rows: SummaryRow[]): KnownMetrics {
  const m = computeMetrics(rows.map(r => ({ ...r, listCost: r.listCost ?? 0 })));
  const known = !hasMissingShipping(rows);
  return { sales: m.sales, fees: m.fees, count: m.count, units: m.units, sat: satRetention(m.sales), envios: known ? m.envios : null, real: known ? m.real : null };
}

// ---------- 2. A dónde se va el dinero ----------
export interface Slice { key: 'net' | 'ship' | 'fee' | 'sat' | 'unknown'; label: string; value: number | null; pct: number | null; }
export function moneyBreakdown(m: KnownMetrics): Slice[] | null {
  if (m.sales <= 0) return null;
  const pct = (v: number) => (v / m.sales) * 100;
  const fee: Slice = { key: 'fee', label: 'Comisión de ML', value: m.fees, pct: pct(m.fees) };
  const sat: Slice = { key: 'sat', label: 'Retenciones SAT', value: m.sat, pct: pct(m.sat) };
  if (m.envios === null || m.real === null) {
    // Falta el costo de envío de alguna orden: no se inventa; el resto queda como "sin determinar"
    const rest = m.sales - m.fees - m.sat;
    return [
      { key: 'ship', label: 'Envíos', value: null, pct: null },
      fee, sat,
      { key: 'unknown', label: 'Ganancia (sin determinar)', value: null, pct: pct(rest) },
    ];
  }
  return [
    { key: 'net', label: 'Ganancia real', value: m.real, pct: pct(m.real) },
    { key: 'ship', label: 'Envíos', value: m.envios, pct: pct(m.envios) },
    fee, sat,
  ];
}

// ---------- 1. Ventas y ganancia en el tiempo ----------
export interface CmpBucket { label: string; p1: number | null; p2: number | null; }
export function compareSeries(rows: SummaryRow[], pair: PeriodPair, metric: 'sales' | 'net'): CmpBucket[] {
  const { cur, prev, groupBy } = pair;
  const nDays = Math.max(diffDays(cur.from, cur.to), diffDays(prev.from, prev.to)) + 1;
  const unit = (d: number) => (groupBy === 'week' ? Math.floor(d / 7) : d);
  const nUnits = unit(nDays - 1) + 1;
  const bucketOf = (span: Span) => {
    const arr: SummaryRow[][] = Array.from({ length: nUnits }, () => []);
    rowsIn(rows, span.from, span.to).forEach(r => arr[unit(diffDays(span.from, r.day))].push(r));
    return arr;
  };
  const b1 = bucketOf(prev), b2 = bucketOf(cur);
  const val = (rs: SummaryRow[], span: Span, i: number): number | null => {
    // Unidades que caen fuera del período más corto no existen: nulo, no cero
    const startDay = i * (groupBy === 'week' ? 7 : 1);
    if (startDay > diffDays(span.from, span.to)) return null;
    const m = metricsOf(rs);
    return metric === 'sales' ? m.sales : m.real;
  };
  const lbl = (span: Span, i: number) => {
    const a = addDays(span.from, i * (groupBy === 'week' ? 7 : 1));
    if (groupBy === 'day') return shortDay(a);
    const b = addDays(a, 6) > span.to ? span.to : addDays(a, 6);
    return `${shortDay(a)}–${shortDay(b)}`;
  };
  return Array.from({ length: nUnits }, (_, i) => ({
    label: `${lbl(prev, i)} / ${lbl(cur, i)}`,
    p1: val(b1[i], prev, i),
    p2: val(b2[i], cur, i),
  }));
}

export interface SingleBucket { label: string; sales: number; net: number | null; }
/** Rango único: diario hasta 45 días; semanal si es más largo para que siga legible. */
export function singleSeries(rows: SummaryRow[], from: string, to: string): { buckets: SingleBucket[]; weekly: boolean } {
  const n = diffDays(from, to) + 1;
  const weekly = n > 45;
  const size = weekly ? 7 : 1;
  const count = Math.ceil(n / size);
  const buckets: SingleBucket[] = [];
  for (let i = 0; i < count; i++) {
    const a = addDays(from, i * size);
    const b = weekly ? (addDays(a, 6) > to ? to : addDays(a, 6)) : a;
    const m = metricsOf(rowsIn(rows, a, b));
    buckets.push({ label: weekly ? `${shortDay(a)}–${shortDay(b)}` : shortDay(a), sales: m.sales, net: m.real });
  }
  return { buckets, weekly };
}

// ---------- Agregados por publicación y por ventana (3 a 7) ----------
export interface ItemAgg {
  id: string; title: string;
  orders: number; units: number; revenue: number; fee: number;
  /** Solo órdenes con costo de envío conocido (para comisión+envío y margen) */
  knownOrders: number; knownRevenue: number; knownFee: number; knownShip: number;
}

/** Suma por publicación; el envío de una orden se reparte entre sus líneas en proporción a su importe. */
export function aggregateItems(rows: SummaryRow[]): Map<string, ItemAgg> {
  const map = new Map<string, ItemAgg>();
  rows.forEach(r => {
    const lines = r.order_items.map(i => ({ i, rev: i.unit_price * i.quantity }));
    const total = lines.reduce((a, l) => a + l.rev, 0);
    lines.forEach(({ i, rev }) => {
      const e = map.get(i.id) || { id: i.id, title: i.title, orders: 0, units: 0, revenue: 0, fee: 0, knownOrders: 0, knownRevenue: 0, knownFee: 0, knownShip: 0 };
      const fee = i.sale_fee * i.quantity;
      e.orders += 1; e.units += i.quantity; e.revenue += rev; e.fee += fee;
      if (r.listCost !== null) {
        e.knownOrders += 1; e.knownRevenue += rev; e.knownFee += fee;
        e.knownShip += total > 0 ? r.listCost * (rev / total) : 0;
      }
      map.set(i.id, e);
    });
  });
  return map;
}

// ---------- 3. Embudo / conversión real ----------
export interface DayFunnel { day: string; label: string; visits: number; orders: number; }
export interface Funnel {
  visits: number | null; orders: number; units: number;
  conversion: number | null; days: DayFunnel[]; daysWithoutVisitData: number;
}
export function buildFunnel(rows: SummaryRow[], from: string, to: string, daily: { date: string; total: number }[] | null): Funnel {
  const vMap = new Map((daily || []).map(d => [d.date, d.total]));
  const oMap = new Map<string, number>();
  rowsIn(rows, from, to).forEach(r => oMap.set(r.day, (oMap.get(r.day) || 0) + 1));
  const days = eachDay(from, to).map(day => ({ day, label: shortDay(day), visits: vMap.get(day) ?? 0, orders: oMap.get(day) || 0 }));
  const orders = days.reduce((a, d) => a + d.orders, 0);
  const units = rowsIn(rows, from, to).reduce((a, r) => a + r.order_items.reduce((s, i) => s + i.quantity, 0), 0);
  const visits = daily === null ? null : days.reduce((a, d) => a + d.visits, 0);
  return {
    visits, orders, units,
    conversion: visits !== null && visits > 0 ? orders / visits : null,
    days, daysWithoutVisitData: daily === null ? 0 : days.filter(d => !vMap.has(d.day)).length,
  };
}

// ---------- 4. Publicaciones que más y menos convierten ----------
export interface ConvRow { id: string; title: string; permalink: string | null; visits: number; orders: number; conversion: number; }
export function conversionRanking(items: AItem[], agg: Map<string, ItemAgg>, minVisits: number, limit = 5): { best: ConvRow[]; worst: ConvRow[]; eligible: number } {
  const eligible: ConvRow[] = items
    .filter(i => i.visits !== null && i.visits >= minVisits)
    .map(i => {
      const orders = agg.get(i.id)?.orders ?? 0;
      return { id: i.id, title: i.title, permalink: i.permalink, visits: i.visits as number, orders, conversion: orders / (i.visits as number) };
    });
  const best = eligible.filter(e => e.orders > 0).sort((a, b) => b.conversion - a.conversion || b.orders - a.orders).slice(0, limit);
  const bestIds = new Set(best.map(b => b.id));
  const worst = eligible.filter(e => !bestIds.has(e.id)).sort((a, b) => a.conversion - b.conversion || b.visits - a.visits).slice(0, limit);
  return { best, worst, eligible: eligible.length };
}

// ---------- 5. Día de la semana y hora ----------
export const DOW_LABELS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
export const HOUR_BLOCK = 4;
export interface Pattern { n: number; byDow: { label: string; orders: number; sales: number }[]; byHour: { label: string; orders: number }[]; }
export function buildPatterns(rows: SummaryRow[]): Pattern {
  const byDow = DOW_LABELS.map(label => ({ label, orders: 0, sales: 0 }));
  const blocks = 24 / HOUR_BLOCK;
  const byHour = Array.from({ length: blocks }, (_, i) => ({ label: `${i * HOUR_BLOCK}–${i * HOUR_BLOCK + HOUR_BLOCK - 1} h`, orders: 0 }));
  rows.forEach(r => {
    const dow = (new Date(r.day + 'T12:00:00Z').getUTCDay() + 6) % 7; // lunes = 0
    byDow[dow].orders += 1; byDow[dow].sales += r.total_amount;
    byHour[Math.floor(r.hour / HOUR_BLOCK)].orders += 1;
  });
  return { n: rows.length, byDow, byHour };
}

// ---------- 6. Clásica vs Premium ----------
export const LISTING_LABEL: Record<string, string> = { gold_special: 'Clásica', gold_pro: 'Premium', free: 'Gratuita' };
export interface TypeRow { type: string; label: string; orders: number; units: number; revenue: number; fee: number; feePct: number | null; }
export function byListingType(agg: Map<string, ItemAgg>, items: AItem[]): { rows: TypeRow[]; unmatchedOrders: number } {
  const typeOf = new Map(items.map(i => [i.id, i.listing_type_id]));
  const acc = new Map<string, TypeRow>();
  let unmatchedOrders = 0;
  agg.forEach(a => {
    const t = typeOf.get(a.id);
    if (!t) { unmatchedOrders += a.orders; return; }
    const e = acc.get(t) || { type: t, label: LISTING_LABEL[t] || t, orders: 0, units: 0, revenue: 0, fee: 0, feePct: null };
    e.orders += a.orders; e.units += a.units; e.revenue += a.revenue; e.fee += a.fee;
    acc.set(t, e);
  });
  const rows = [...acc.values()].map(r => ({ ...r, feePct: r.revenue > 0 ? (r.fee / r.revenue) * 100 : null })).sort((a, b) => b.revenue - a.revenue);
  return { rows, unmatchedOrders };
}

/** Umbrales de muestra mínima para no sacar conclusiones de pocos datos. */
export const MIN_RANK_VISITS = 30;       // publicaciones con menos visitas en la ventana no entran al ranking de conversión
export const MIN_PATTERN_ORDERS = 30;    // por debajo, día de la semana / hora se muestran como "muestra pequeña"
export const WINDOW_OPTIONS = [30, 60, 90] as const;
