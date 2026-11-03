import { satRetention } from '../shared/order-math';
import { AItem, ItemAgg } from './analytics-data';

/**
 * Umbrales de los tips de Analytics. Todo lo que decide si un tip aparece vive aquí; cambiar un número
 * cambia la regla. Son reglas fijas (sin IA) y los textos son sugerencias, no afirmaciones sobre causas.
 */
export const TIP_THRESHOLDS = {
  /** Mínimo de días de la ventana para evaluar reglas que usan visitas */
  minWindowDays: 30,
  /** Muchas visitas y pocas ventas */
  highVisits: { minVisits: 60, maxConversion: 0.01 },
  /** Con ventas recientes y casi sin stock */
  lowStock: { maxStock: 3, minUnitsSold: 2 },
  /** Activa, sin visitas en 30 días (y con al menos esa antigüedad) */
  noVisits: { days: 30 },
  /** Comisión + envío se comen demasiado de la venta */
  feesShare: { minShare: 0.35, minOrders: 2 },
  /** Margen real bajo (ventas - comisión - envío - SAT) */
  lowMargin: { maxMargin: 0.10, minOrders: 2 },
  /** Cuántas publicaciones se nombran por tip */
  maxListed: 5,
} as const;

export interface TipItem { id: string; title: string; permalink: string | null; fact: string; }
export interface Tip {
  id: string;
  title: string;
  /** Redactado como sugerencia, nunca como causa afirmada */
  advice: string;
  items: TipItem[];
  /** Total que cumple la regla (puede ser mayor que items.length) */
  total: number;
}
export interface TipsResult {
  tips: Tip[];
  /** Reglas que no se pudieron evaluar y por qué */
  skipped: string[];
}

const pct1 = (v: number) => (v * 100).toLocaleString('es-MX', { maximumFractionDigits: 1 }) + '%';
const int = (v: number) => v.toLocaleString('es-MX');

export interface TipInput {
  items: AItem[];
  agg: Map<string, ItemAgg>;
  windowDays: number;
  /** false si faltaron visitas o la ventana de visitas de la cuenta */
  visitsReliable: boolean;
  today: string;
}

export function buildTips(input: TipInput): TipsResult {
  const T = TIP_THRESHOLDS;
  const { items, agg, windowDays, today } = input;
  const tips: Tip[] = [];
  const skipped: string[] = [];
  const mk = (list: TipItem[], base: Omit<Tip, 'items' | 'total'>): void => {
    if (list.length) tips.push({ ...base, items: list.slice(0, T.maxListed), total: list.length });
  };
  const toItem = (i: AItem, fact: string): TipItem => ({ id: i.id, title: i.title, permalink: i.permalink, fact });
  const enoughWindow = windowDays >= T.minWindowDays;

  // 1) Muchas visitas y pocas ventas
  if (!enoughWindow) skipped.push(`Visitas vs ventas: la ventana (${windowDays} días) es menor a ${T.minWindowDays}.`);
  else {
    const rows = items
      .filter(i => i.status === 'active' && i.visits !== null && i.visits >= T.highVisits.minVisits)
      .map(i => ({ i, orders: agg.get(i.id)?.orders ?? 0, visits: i.visits as number }))
      .filter(r => r.orders / r.visits < T.highVisits.maxConversion)
      .sort((a, b) => b.visits - a.visits);
    mk(rows.map(r => toItem(r.i, `${int(r.visits)} visitas, ${r.orders} ${r.orders === 1 ? 'orden' : 'órdenes'} en ${windowDays} días (${pct1(r.orders / r.visits)})`)), {
      id: 'high-visits',
      title: 'Reciben visitas pero casi no venden',
      advice: `Con al menos ${T.highVisits.minVisits} visitas y menos de ${pct1(T.highVisits.maxConversion)} de conversión, podría valer la pena revisar el precio, las fotos y el título.`,
    });
  }

  // 2) Sin stock / por agotarse con ventas recientes
  const stockRows = items
    .filter(i => i.status !== 'closed' && i.available_quantity <= T.lowStock.maxStock && (agg.get(i.id)?.units ?? 0) >= T.lowStock.minUnitsSold)
    .sort((a, b) => (agg.get(b.id)?.units ?? 0) - (agg.get(a.id)?.units ?? 0));
  mk(stockRows.map(i => toItem(i, `${i.available_quantity === 0 ? 'Sin stock' : `Quedan ${i.available_quantity}`} · ${agg.get(i.id)?.units} uds. vendidas en ${windowDays} días`)), {
    id: 'low-stock',
    title: 'Se venden y les queda poco stock',
    advice: `Tienen ${T.lowStock.minUnitsSold} o más unidades vendidas en la ventana y ${T.lowStock.maxStock} o menos disponibles. Quizá convenga reponer.`,
  });

  // 3) Activas sin visitas en 30 días
  const cutoff = Date.parse(today + 'T00:00:00Z') - T.noVisits.days * 86_400_000;
  const noVisitRows = items
    .filter(i => i.status === 'active' && i.visits30 === 0 && i.date_created && Date.parse(i.date_created) <= cutoff)
    .sort((a, b) => Date.parse(a.date_created as string) - Date.parse(b.date_created as string));
  mk(noVisitRows.map(i => toItem(i, `0 visitas en ${T.noVisits.days} días · publicada ${new Date(i.date_created as string).toLocaleDateString('es-MX', { month: 'short', year: 'numeric' })}`)), {
    id: 'no-visits',
    title: 'Activas sin visitas en 30 días',
    advice: 'Estas publicaciones llevan al menos 30 días publicadas y no registraron visitas. Podrías probar otro título, otra categoría o pausarlas.',
  });

  // 4) Comisión + envío se comen mucho de la venta  /  5) Margen bajo (solo órdenes con envío conocido)
  const byId = new Map(items.map(i => [i.id, i]));
  const money = (v: number) => v.toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
  const feeRows: { i: AItem; share: number; a: ItemAgg }[] = [];
  const marginRows: { i: AItem; margin: number; a: ItemAgg }[] = [];
  agg.forEach(a => {
    const i = byId.get(a.id);
    if (!i || a.knownOrders < Math.min(T.feesShare.minOrders, T.lowMargin.minOrders) || a.knownRevenue <= 0) return;
    const share = (a.knownFee + a.knownShip) / a.knownRevenue;
    const margin = 1 - (a.knownFee + a.knownShip + satRetention(a.knownRevenue)) / a.knownRevenue;
    if (a.knownOrders >= T.feesShare.minOrders && share >= T.feesShare.minShare) feeRows.push({ i, share, a });
    if (a.knownOrders >= T.lowMargin.minOrders && margin <= T.lowMargin.maxMargin) marginRows.push({ i, margin, a });
  });
  mk(feeRows.sort((x, y) => y.share - x.share).map(r => toItem(r.i, `Comisión + envío = ${pct1(r.share)} de la venta (${r.a.knownOrders} órdenes, ${money(r.a.knownRevenue)})`)), {
    id: 'fees-share',
    title: 'Comisión y envío pesan mucho en la venta',
    advice: `En estas publicaciones la comisión de ML más el envío suman ${pct1(T.feesShare.minShare)} o más del precio. Podrías revisar el precio o el tipo de publicación.`,
  });
  mk(marginRows.sort((x, y) => x.margin - y.margin).map(r => toItem(r.i, `Margen ${pct1(r.margin)} tras comisión, envío y SAT (${r.a.knownOrders} órdenes)`)), {
    id: 'low-margin',
    title: 'Margen bajo después de costos',
    advice: `Después de comisión, envío y retenciones SAT queda ${pct1(T.lowMargin.maxMargin)} o menos de la venta. Si tienes costo del producto, quizá no estén dejando ganancia.`,
  });

  if (!input.visitsReliable) skipped.push('Algunas visitas no se pudieron obtener de Mercado Libre: las reglas de visitas solo consideran las publicaciones con dato.');
  return { tips, skipped };
}
