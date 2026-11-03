// Retenciones SAT que aplica MercadoLibre (plataformas digitales), igual que en su
// "Detalle de la venta": se calculan sobre el precio SIN IVA (total / 1.16).
export const IVA_RATE = 0.16;
export const ISR_RETENTION_RATE = 0.025;
export const IVA_RETENTION_RATE = 0.08;
export const SAT_RETENTION_RATE = ISR_RETENTION_RATE + IVA_RETENTION_RATE;

// Comisión de ML de todos los artículos de la orden (sale_fee es por unidad)
export function orderSaleFee(order: { order_items: { quantity: number; sale_fee: number }[] }): number {
  return order.order_items.reduce((sum, item) => sum + item.sale_fee * item.quantity, 0);
}

export function satRetention(totalAmount: number): number {
  return (totalAmount / (1 + IVA_RATE)) * SAT_RETENTION_RATE;
}
