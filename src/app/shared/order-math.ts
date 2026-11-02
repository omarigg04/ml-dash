import { Order } from '../interfaces/Order.interface';

// Retenciones SAT a vendedores en plataformas: 1% ISR + 8% IVA sobre el total
export const SAT_RETENTION_RATE = 0.01 + 0.08;

// Comisión de ML de todos los artículos de la orden (sale_fee es por unidad)
export function orderSaleFee(order: Pick<Order, 'order_items'>): number {
  return order.order_items.reduce((sum, item) => sum + item.sale_fee * item.quantity, 0);
}

export function satRetention(totalAmount: number): number {
  return totalAmount * SAT_RETENTION_RATE;
}
