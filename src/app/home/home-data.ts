import { computeMetrics, Metrics, pctChange } from '../shared/sales-metrics';
import { satRetention } from '../shared/order-math';

/** Fila de GET /api/summary: una orden reducida (sin datos del comprador). listCost null = costo de envío sin resolver. */
export interface SummaryRow {
  id: number;
  day: string; // YYYY-MM-DD en la zona horaria pedida
  hour: number; // 0-23 en esa misma zona
  total_amount: number;
  order_items: { id: string; title: string; quantity: number; sale_fee: number; unit_price: number }[];
  listCost: number | null;
}

export interface SummaryResponse {
  range: { from: string; to: string; prevFrom: string; prevTo: string; chartFrom: string; tz: string };
  orders: SummaryRow[];
  partial: boolean;
  shippingMissing: number;
  truncated: boolean;
  meta: { ms: number; mlCalls: number; orders: number };
}

export type PeriodKey = 'month' | '30d' | 'lastmonth';

export interface PeriodRange {
  from: string; to: string; prevFrom: string; prevTo: string;
  /** "5 oct – 3 nov" */
  label: string;
}

export const PERIODS: { key: PeriodKey; label: string }[] = [
  { key: 'month', label: 'Este mes' },
  { key: '30d', label: 'Últimos 30 días' },
  { key: 'lastmonth', label: 'Mes pasado' },
];

const DAY_MS = 86_400_000;
const pad = (n: number) => String(n).padStart(2, '0');
/** Fecha local -> YYYY-MM-DD (sin pasar por UTC, para no correr el día). */
export const ymd = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (day: string, n: number): string => new Date(Date.parse(day + 'T00:00:00Z') + n * DAY_MS).toISOString().slice(0, 10);

/** Fecha corta "5 oct" a partir de YYYY-MM-DD (se formatea en UTC para que no dependa de la zona). */
export function shortDay(day: string): string {
  return new Date(day + 'T12:00:00Z').toLocaleDateString('es-MX', { day: 'numeric', month: 'short', timeZone: 'UTC' }).replace('.', '');
}

export function rangeLabel(from: string, to: string): string {
  const [f, t] = [shortDay(from), shortDay(to)];
  if (from === to) return f;
  // "1 – 31 oct" si es el mismo mes; "5 oct – 3 nov" si cruza
  return from.slice(0, 7) === to.slice(0, 7) ? `${f.split(' ')[0]} – ${t}` : `${f} – ${t}`;
}

/** Rangos del período y del período equivalente anterior (misma duración, o mes anterior con los mismos días). */
export function periodRange(key: PeriodKey, now = new Date()): PeriodRange {
  const today = ymd(now);
  const y = now.getFullYear(), m = now.getMonth();
  let from: string, to: string, prevFrom: string, prevTo: string;
  if (key === '30d') {
    to = today; from = addDays(today, -29);
    prevTo = addDays(from, -1); prevFrom = addDays(from, -30);
  } else if (key === 'month') {
    from = ymd(new Date(y, m, 1)); to = today;
    prevFrom = ymd(new Date(y, m - 1, 1));
    const lastPrev = new Date(y, m, 0).getDate();
    prevTo = ymd(new Date(y, m - 1, Math.min(now.getDate(), lastPrev)));
  } else {
    from = ymd(new Date(y, m - 1, 1)); to = ymd(new Date(y, m, 0));
    prevFrom = ymd(new Date(y, m - 2, 1)); prevTo = ymd(new Date(y, m - 1, 0));
  }
  return { from, to, prevFrom, prevTo, label: rangeLabel(from, to) };
}

export interface HomeKpis {
  sales: number;
  /** null = faltan costos de envío: no se muestra como $0 */
  net: number | null;
  orders: number;
  fees: number;
  envios: number | null;
  sat: number;
  feesPct: number | null;
  enviosPerOrder: number | null;
  deltaSales: number | null;
  deltaNet: number | null;
  deltaOrders: number | null;
}

export interface DayPoint { day: string; label: string; sales: number; net: number | null; orders: number; }
export interface TopSeller { id: string; title: string; units: number; pct: number; }

const inRange = (rows: SummaryRow[], a: string, b: string) => rows.filter(r => r.day >= a && r.day <= b);
const hasMissing = (rows: SummaryRow[]) => rows.some(r => r.listCost === null);
/** Mismas métricas que Analytics; los costos sin resolver cuentan 0 solo para sumar ventas/comisiones (nunca se muestran). */
const metricsOf = (rows: SummaryRow[]): Metrics => computeMetrics(rows.map(r => ({ ...r, listCost: r.listCost ?? 0 })));

export function buildKpis(rows: SummaryRow[], p: PeriodRange): HomeKpis {
  const curRows = inRange(rows, p.from, p.to);
  const prevRows = inRange(rows, p.prevFrom, p.prevTo);
  const cur = metricsOf(curRows), prev = metricsOf(prevRows);
  const curKnown = !hasMissing(curRows), prevKnown = !hasMissing(prevRows);
  return {
    sales: cur.sales,
    net: curKnown ? cur.real : null,
    orders: cur.count,
    fees: cur.fees,
    envios: curKnown ? cur.envios : null,
    sat: satRetention(cur.sales),
    feesPct: cur.sales > 0 ? (cur.fees / cur.sales) * 100 : null,
    enviosPerOrder: curKnown && cur.count > 0 ? cur.envios / cur.count : null,
    deltaSales: pctChange(cur.sales, prev.sales),
    deltaNet: curKnown && prevKnown ? pctChange(cur.real, prev.real) : null,
    deltaOrders: pctChange(cur.count, prev.count),
  };
}

/** Un punto por día de a..b (los días sin ventas valen 0). */
export function dailySeries(rows: SummaryRow[], a: string, b: string): DayPoint[] {
  const byDay = new Map<string, SummaryRow[]>();
  inRange(rows, a, b).forEach(r => byDay.set(r.day, [...(byDay.get(r.day) || []), r]));
  const out: DayPoint[] = [];
  for (let d = a; d <= b; d = addDays(d, 1)) {
    const dayRows = byDay.get(d) || [];
    const m = metricsOf(dayRows);
    out.push({ day: d, label: String(Number(d.slice(8, 10))), sales: m.sales, net: hasMissing(dayRows) ? null : m.real, orders: m.count });
  }
  return out;
}

/** Más vendidos del período: unidades por publicación sumadas desde las órdenes (no el sold_quantity histórico). */
export function topSellers(rows: SummaryRow[], p: PeriodRange, limit = 5): TopSeller[] {
  const units = new Map<string, { title: string; units: number }>();
  inRange(rows, p.from, p.to).forEach(r => r.order_items.forEach(i => {
    const e = units.get(i.id) || { title: i.title, units: 0 };
    e.units += i.quantity;
    units.set(i.id, e);
  }));
  const list = [...units.entries()].map(([id, v]) => ({ id, title: v.title, units: v.units }))
    .sort((x, y) => y.units - x.units || x.title.localeCompare(y.title)).slice(0, limit);
  const max = Math.max(1, ...list.map(l => l.units));
  return list.map(l => ({ ...l, pct: Math.max(4, Math.round((l.units / max) * 100)) }));
}
