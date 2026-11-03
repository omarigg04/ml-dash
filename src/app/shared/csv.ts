/**
 * Celda CSV entre comillas. Neutraliza la inyección de fórmulas en hojas de cálculo: un texto que empieza
 * con = + - @ (o tab/CR) se antepone con apóstrofo. Los números no se tocan (un -3.2 sigue siendo número).
 */
export function csvCell(v: unknown): string {
  let s = v == null ? '' : String(v);
  if (typeof v !== 'number' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}
