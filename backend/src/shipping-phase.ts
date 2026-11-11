/**
 * Fase de un envío con los mismos nombres que Mercado Libre muestra en Ventas.
 *
 * ML marca "En camino" un envío que sigue en ready_to_ship pero que ya dejaste en la agencia o que ya
 * recogió la paquetería (comprobado con órdenes reales: ready_to_ship + dropped_off sale "En camino").
 * Un subestado desconocido de ready_to_ship se queda en "Por enviar": nunca se da por enviado sin certeza.
 */
export type ShippingPhase = 'to_ship' | 'in_transit' | 'delivered' | 'cancelled';

const HANDED_OVER = new Set(['dropped_off', 'picked_up', 'in_hub']);

export function shippingPhase(status: string | null | undefined, substatus?: string | null): ShippingPhase | null {
    switch (status) {
        case 'pending':
        case 'handling':
            return 'to_ship';
        case 'ready_to_ship':
            return substatus && HANDED_OVER.has(substatus) ? 'in_transit' : 'to_ship';
        case 'shipped':
            return 'in_transit';
        case 'delivered':
            return 'delivered';
        case 'cancelled':
            return 'cancelled';
        default:
            return null; // not_delivered, returned u otro: la app usa los tags de la orden
    }
}
