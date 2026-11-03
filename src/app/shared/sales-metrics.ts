import { orderSaleFee, satRetention } from './order-math';

/** Mínimo que necesita la fórmula de ventas: lo cumplen tanto Order (Analytics) como las filas de /api/summary (Inicio). */
export interface MetricOrder {
  total_amount: number;
  listCost: number;
  order_items: { quantity: number; sale_fee: number }[];
}

export interface Metrics {
  sales: number;
  fees: number;
  envios: number;
  real: number;
  count: number;
  units: number;
}

/** Ventas, comisiones, envíos, ganancia real (ventas - SAT - envíos - comisiones), órdenes y unidades. */
export function computeMetrics(orders: MetricOrder[]): Metrics {
  const sales = orders.reduce((acc, o) => acc + o.total_amount, 0);
  const fees = orders.reduce((acc, o) => acc + orderSaleFee(o), 0);
  const envios = orders.reduce((acc, o) => acc + o.listCost, 0);
  const real = sales - (satRetention(sales) + envios + fees);
  const units = orders.reduce((acc, o) => acc + o.order_items.reduce((sum, item) => sum + item.quantity, 0), 0);
  return { sales, fees, envios, real, count: orders.length, units };
}

/** Variación % contra el período anterior (null si no hay base). */
export function pctChange(cur: number, prev: number): number | null {
  return prev > 0 ? ((cur - prev) / prev) * 100 : null;
}
