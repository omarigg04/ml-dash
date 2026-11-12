import { A, ml, freshApp, resetAll, seedBoth, withServer, get } from './support';
import axios, { AxiosError } from 'axios';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { shippingPhase } from '../src/shipping-phase';

beforeEach(resetAll);

test('fase del envío: los mismos nombres que Ventas de Mercado Libre', () => {
    // Combinaciones vistas en órdenes reales
    assert.equal(shippingPhase('ready_to_ship', 'dropped_off'), 'in_transit');
    assert.equal(shippingPhase('shipped', 'out_for_delivery'), 'in_transit');
    assert.equal(shippingPhase('delivered', null), 'delivered');
    assert.equal(shippingPhase('cancelled', null), 'cancelled');
    // Entregado a la paquetería
    assert.equal(shippingPhase('ready_to_ship', 'picked_up'), 'in_transit');
    assert.equal(shippingPhase('ready_to_ship', 'in_hub'), 'in_transit');
    // Aún en tus manos, o sin certeza
    assert.equal(shippingPhase('ready_to_ship', 'ready_to_print'), 'to_ship');
    assert.equal(shippingPhase('ready_to_ship', 'printed'), 'to_ship');
    assert.equal(shippingPhase('ready_to_ship', null), 'to_ship');
    assert.equal(shippingPhase('ready_to_ship', 'algo_nuevo'), 'to_ship');
    assert.equal(shippingPhase('handling', null), 'to_ship');
    assert.equal(shippingPhase('pending', null), 'to_ship');
    // Sin regla: la app usa los tags de la orden
    assert.equal(shippingPhase('not_delivered', null), null);
    assert.equal(shippingPhase(undefined), null);
});

// ---- ML falso: órdenes y envíos con los estados reales vistos ----
const baseAdapter = axios.defaults.adapter as any;
const SHIPMENTS: Record<string, { status: string; substatus: string | null } | 'error'> = {
    '11': { status: 'ready_to_ship', substatus: 'dropped_off' },   // ya en la agencia: "En camino"
    '12': { status: 'ready_to_ship', substatus: 'printed' },       // etiqueta impresa: "Por enviar"
    '13': { status: 'shipped', substatus: 'out_for_delivery' },
    '14': 'error',
};
const order = (n: number, ship: number, over: any = {}) => ({
    id: 2000019000000000 + n, pack_id: 2000015000000000 + n, status: 'paid', tags: ['paid', 'not_delivered', 'pack_order'],
    date_created: new Date().toISOString(), total_amount: 100, shipping: { id: ship },
    buyer: { id: 9, nickname: 'COMPRADOR' }, payments: [], order_items: [{ item: { id: 'MLM1', title: 'X' }, quantity: 1, unit_price: 100, sale_fee: 10 }],
    ...over,
});
const ORDERS = [
    order(1, 11), order(2, 12), order(3, 13), order(4, 14),
    order(5, 15, { tags: ['paid', 'delivered', 'pack_order'] }),
    order(6, 16, { status: 'cancelled', tags: ['not_delivered', 'not_paid'] }),
    order(7, 17, { pack_id: null }),
];

const fakeMl = () => {
    axios.defaults.adapter = async (config: any) => {
        const u = new URL(config.url, 'https://api.mercadolibre.com');
        const res = (data: any) => ({ data, status: 200, statusText: 'OK', headers: {}, config });
        const authH = config.headers?.get ? config.headers.get('Authorization') : config.headers?.Authorization;
        const uid = ml.access.get(String(authH || '').replace(/^Bearer /, '')) ?? null;
        if (uid !== null) {
            let m: RegExpExecArray | null;
            if (u.pathname === '/orders/search') {
                ml.calls.push({ method: 'GET', url: u.pathname, token: null, uid });
                return res({ results: ORDERS, paging: { total: ORDERS.length, offset: 0, limit: 50 } });
            }
            if ((m = /^\/orders\/(\d+)$/.exec(u.pathname))) return res(ORDERS.find(o => String(o.id) === m![1]));
            if ((m = /^\/shipments\/(\d+)$/.exec(u.pathname))) {
                ml.calls.push({ method: 'GET', url: u.pathname, token: null, uid });
                const s = SHIPMENTS[m[1]] ?? { status: 'ready_to_ship', substatus: null };
                if (s === 'error') {
                    throw new AxiosError('status 500', 'ERR_BAD_RESPONSE', config, null, { data: {}, status: 500, statusText: '500', headers: {}, config } as any);
                }
                return res({ id: Number(m[1]), ...s, shipping_option: { list_cost: 5 } });
            }
            if (/^\/shipments\/\d+\/costs$/.test(u.pathname)) return res({ senders: [{ cost: 5 }] });
        }
        return baseAdapter(config);
    };
};
const restore = () => { axios.defaults.adapter = baseAdapter; };

test('/api/orders: número de venta y estado del envío de las órdenes abiertas', async () => {
    seedBoth();
    fakeMl();
    const { app } = freshApp();
    try {
        await withServer(app, async base => {
            const r = await get(base, '/api/orders', A);
            assert.equal(r.status, 200);
            const byId = new Map<number, any>(r.body.map((o: any) => [o.id, o]));
            const at = (n: number) => byId.get(2000019000000000 + n);

            assert.equal(at(1).pack_id, 2000015000000001);
            assert.equal(at(7).pack_id, null);

            assert.equal(at(1).shipping.phase, 'in_transit');
            assert.equal(at(1).shipping.substatus, 'dropped_off');
            assert.equal(at(2).shipping.phase, 'to_ship');
            assert.equal(at(3).shipping.phase, 'in_transit');
            // Si falla la consulta, la orden queda sin estado (la app usa sus tags)
            assert.deepEqual(at(4).shipping, { id: 14 });

            // Entregadas y canceladas no consultan su envío
            const shipCalls = ml.calls.filter(c => c.url.startsWith('/shipments/')).map(c => c.url);
            assert.ok(!shipCalls.includes('/shipments/15') && !shipCalls.includes('/shipments/16'), shipCalls.join());
            assert.deepEqual(at(5).shipping, { id: 15 });

            // Sin datos del comprador más allá del apodo
            assert.deepEqual(at(1).buyer, { nickname: 'COMPRADOR' });
        });
    } finally { restore(); }
});

test('/api/shipments: devuelve la fase para que el detalle diga lo mismo que la tabla', async () => {
    seedBoth();
    fakeMl();
    const { app } = freshApp();
    try {
        await withServer(app, async base => {
            const inAgency = await get(base, '/api/shipments/11', A);
            assert.equal(inAgency.body.status, 'ready_to_ship');
            assert.equal(inAgency.body.substatus, 'dropped_off');
            assert.equal(inAgency.body.phase, 'in_transit');
            assert.equal((await get(base, '/api/shipments/12', A)).body.phase, 'to_ship');
        });
    } finally { restore(); }
});

test('insignia de pendientes: no cuenta envíos ya dejados en la agencia ni en camino', async () => {
    seedBoth();
    fakeMl();
    const { app } = freshApp();
    try {
        await withServer(app, async base => {
            const r = await get(base, '/api/summary/pending', A);
            assert.equal(r.status, 200);
            // Por enviar: el 12 (impreso) y el 17 (ready_to_ship sin subestado). El 14 falló: no se cuenta.
            assert.equal(r.body.count, 2);
            assert.equal(r.body.partial, true);
        });
    } finally { restore(); }
});
