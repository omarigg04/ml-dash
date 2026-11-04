import { A, ml, freshApp, resetAll, seedBoth, sessionCookie, withServer, get } from './support';
import axios, { AxiosError } from 'axios';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { orderNet, orderSaleFee, satRetention } from '../../src/app/shared/order-math';
import { computeMetrics, pctChange } from '../../src/app/shared/sales-metrics';
import { buildKpis, dailySeries, PeriodRange, SummaryRow } from '../../src/app/home/home-data';
import { aggregateItems, metricsOf, moneyBreakdown } from '../../src/app/analytics/analytics-data';

// Los valores esperados están calculados a mano: no reutilizan las fórmulas que se prueban.
const near = (actual: number | null, expected: number) => {
    assert.ok(actual !== null, 'se esperaba un número');
    assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
};

const row = (over: Partial<SummaryRow> = {}): SummaryRow => ({
    id: 1, day: '2026-10-15', hour: 12, total_amount: 1160, listCost: 100,
    order_items: [{ id: 'MLM1', title: 'Uno', quantity: 2, sale_fee: 50, unit_price: 580 }],
    ...over,
});
const PERIOD: PeriodRange = { from: '2026-10-01', to: '2026-10-31', prevFrom: '2026-09-01', prevTo: '2026-09-30', label: '' };

// ---------- Fórmulas ----------
test('SAT: 10.5% sobre el precio sin IVA', () => {
    near(satRetention(1160), 105);   // 1160 / 1.16 = 1000; 1000 * 0.105
    near(satRetention(0), 0);
});

test('comisión: sale_fee es por unidad y se suman todas las líneas', () => {
    const order = { order_items: [{ quantity: 2, sale_fee: 50 }, { quantity: 1, sale_fee: 30 }] };
    assert.equal(orderSaleFee(order), 130);
});

test('ganancia de una orden: resta comisión, SAT y envío', () => {
    const order = { total_amount: 1160, order_items: [{ quantity: 2, sale_fee: 50 }] };
    near(orderNet(order, 100), 855);  // 1160 - 100 - 105 - 100
    near(orderNet(order, 0), 955);    // envío conocido en $0 (sin envío o lo paga el comprador)
});

test('ganancia de una orden: costo de envío desconocido da null, no se calcula como $0', () => {
    const order = { total_amount: 1160, order_items: [{ quantity: 2, sale_fee: 50 }] };
    assert.equal(orderNet(order, null), null);
});

test('métricas de varias órdenes', () => {
    const m = computeMetrics([
        { total_amount: 1160, listCost: 100, order_items: [{ quantity: 2, sale_fee: 50 }] },
        { total_amount: 580, listCost: 0, order_items: [{ quantity: 1, sale_fee: 40 }] },
    ]);
    assert.equal(m.sales, 1740);
    assert.equal(m.fees, 140);
    assert.equal(m.envios, 100);
    near(m.real, 1342.5);   // 1740 - 157.5 SAT - 100 - 140
    assert.equal(m.count, 2);
    assert.equal(m.units, 3);
});

test('sin ventas todo vale 0, sin dividir entre cero', () => {
    assert.deepEqual(computeMetrics([]), { sales: 0, fees: 0, envios: 0, real: 0, count: 0, units: 0 });
});

test('variación %: sin base positiva no hay porcentaje', () => {
    assert.equal(pctChange(150, 100), 50);
    assert.equal(pctChange(50, 0), null);
    assert.equal(pctChange(50, -10), null);
});

// ---------- Inicio ----------
test('Inicio: los KPI solo cuentan órdenes del período, incluidos el primer y el último día', () => {
    const rows = [
        row({ id: 1, day: '2026-10-01' }), row({ id: 2, day: '2026-10-31' }),
        row({ id: 3, day: '2026-09-30', total_amount: 580, listCost: 0 }), row({ id: 4, day: '2026-11-01' }),
    ];
    const k = buildKpis(rows, PERIOD);
    assert.equal(k.sales, 2320);
    assert.equal(k.orders, 2);
    near(k.net, 1710);   // 2 * 855
    near(k.sat, 210);
    assert.equal(k.fees, 200);
    assert.equal(k.envios, 200);
    near(k.feesPct, (200 / 2320) * 100);
    assert.equal(k.enviosPerOrder, 100);
    assert.equal(k.deltaSales, 300);   // 2320 contra 580
});

test('Inicio: si falta un envío, la ganancia y los envíos quedan sin determinar y las ventas siguen', () => {
    const k = buildKpis([row(), row({ id: 2, listCost: null })], PERIOD);
    assert.equal(k.sales, 2320);
    assert.equal(k.net, null);
    assert.equal(k.envios, null);
    assert.equal(k.enviosPerOrder, null);
    assert.equal(k.deltaNet, null);
});

test('Inicio: si falta un envío del período anterior, no se compara la ganancia', () => {
    const k = buildKpis([row(), row({ id: 2, day: '2026-09-15', listCost: null })], PERIOD);
    near(k.net, 855);
    assert.equal(k.deltaNet, null);
    assert.equal(k.deltaSales, 0);
});

test('Inicio: el envío desconocido solo deja sin ganancia a su propio día', () => {
    const s = dailySeries([row({ day: '2026-10-01' }), row({ id: 2, day: '2026-10-02', listCost: null })], '2026-10-01', '2026-10-03');
    near(s[0].net, 855);
    assert.equal(s[1].net, null);
    assert.equal(s[1].sales, 1160);
    assert.equal(s[2].net, 0);
    assert.equal(s[2].sales, 0);
});

// ---------- Analytics ----------
test('Inicio y Analytics dan los mismos números', () => {
    const rows = [row(), row({ id: 2, total_amount: 580, listCost: 0 })];
    const k = buildKpis(rows, PERIOD), m = metricsOf(rows);
    assert.equal(k.sales, m.sales);
    assert.equal(k.net, m.real);
    assert.equal(k.fees, m.fees);
    assert.equal(k.envios, m.envios);
    assert.equal(k.sat, m.sat);
});

test('A dónde se va el dinero: las partes suman el 100% de las ventas', () => {
    const slices = moneyBreakdown(metricsOf([row()]))!;
    near(slices.reduce((a, s) => a + s.value!, 0), 1160);
    near(slices.reduce((a, s) => a + s.pct!, 0), 100);
});

test('A dónde se va el dinero: con un envío desconocido no se muestra ganancia ni envíos', () => {
    const slices = moneyBreakdown(metricsOf([row({ listCost: null })]))!;
    assert.equal(slices.find(s => s.key === 'net'), undefined);
    assert.equal(slices.find(s => s.key === 'ship')!.value, null);
    assert.equal(slices.find(s => s.key === 'unknown')!.value, null);
    near(slices.find(s => s.key === 'unknown')!.pct, (955 / 1160) * 100);   // sin envío: 1160 - 100 - 105
    assert.equal(moneyBreakdown(metricsOf([])), null);
});

test('por publicación: el envío se reparte según el importe de cada línea y no se pierde nada', () => {
    const map = aggregateItems([row({
        total_amount: 400, listCost: 90,
        order_items: [
            { id: 'A', title: 'A', quantity: 3, sale_fee: 10, unit_price: 100 },
            { id: 'B', title: 'B', quantity: 1, sale_fee: 5, unit_price: 100 },
        ],
    })]);
    near(map.get('A')!.knownShip, 67.5);
    near(map.get('B')!.knownShip, 22.5);
    assert.equal(map.get('A')!.fee, 30);
    assert.equal(map.get('A')!.revenue, 300);
    assert.equal(map.get('A')!.units, 3);
});

test('por publicación: una orden sin envío conocido suma ventas pero no entra en el margen', () => {
    const e = aggregateItems([row({ listCost: null })]).get('MLM1')!;
    assert.equal(e.revenue, 1160);
    assert.equal(e.knownOrders, 0);
    assert.equal(e.knownRevenue, 0);
    assert.equal(e.knownShip, 0);
});

// ---------- API: costo de envío ----------
beforeEach(resetAll);

const baseAdapter = axios.defaults.adapter as any;
const respondCosts = (status: number, senders?: { cost: number }[]) => {
    axios.defaults.adapter = async (config: any) => {
        if (/\/shipments\/\d+\/costs$/.test(new URL(config.url, 'https://api.mercadolibre.com').pathname)) {
            const res = { data: { senders }, status, statusText: String(status), headers: {}, config };
            if (status >= 400) throw new AxiosError(`status ${status}`, 'ERR_BAD_REQUEST', config, null, res as any);
            return res;
        }
        return baseAdapter(config);
    };
};
const restoreAdapter = () => { axios.defaults.adapter = baseAdapter; };

test('/api/shipments: el costo es la suma de senders, y $0 se respeta', async () => {
    seedBoth();
    const { app } = freshApp();
    await withServer(app, async base => {
        try {
            respondCosts(200, [{ cost: 30 }, { cost: 12.5 }]);
            assert.equal((await get(base, '/api/shipments/7', A)).body.listCost, 42.5);
            respondCosts(200, [{ cost: 0 }]);
            assert.equal((await get(base, '/api/shipments/7', A)).body.listCost, 0);
        } finally { restoreAdapter(); }
    });
});

test('/api/shipments: si ML dice que /costs no aplica, se usa list_cost', async () => {
    seedBoth();
    const { app } = freshApp();
    await withServer(app, async base => {
        try {
            respondCosts(404);
            assert.equal((await get(base, '/api/shipments/7', A)).body.listCost, 5);
        } finally { restoreAdapter(); }
    });
});

for (const status of [429, 500, 503]) {
    test(`/api/shipments: con ${status} en /costs no se adivina el costo`, async () => {
        seedBoth();
        const { app } = freshApp();
        await withServer(app, async base => {
            try {
                respondCosts(status);
                const r = await get(base, '/api/shipments/7', A);
                assert.equal(r.status, 503);
                assert.equal(r.body.code, 'SHIPPING_COST_UNAVAILABLE');
                assert.equal(r.body.listCost, undefined);
            } finally { restoreAdapter(); }
        });
    });
}

test('/api/summary y /api/shipments dan el mismo costo para la misma orden', async () => {
    seedBoth();
    const { app } = freshApp();
    await withServer(app, async base => {
        const today = new Date().toISOString().slice(0, 10);
        const summary = await get(base, `/api/summary?from=${today}&to=${today}`, A);
        assert.equal(summary.body.orders[0].listCost, 11);
        assert.equal((await get(base, '/api/shipments/1', A)).body.listCost, 11);
    });
});

test('/api/summary: con /costs limitado la orden queda sin costo y la respuesta es parcial', async () => {
    seedBoth();
    const { app } = freshApp();
    await withServer(app, async base => {
        try {
            respondCosts(404);
            const today = new Date().toISOString().slice(0, 10);
            const fallback = await get(base, `/api/summary?from=${today}&to=${today}`, A);
            assert.equal(fallback.body.partial, false);
            assert.equal(fallback.body.orders[0].listCost, 5);
        } finally { restoreAdapter(); }
    });
    resetAll();
    seedBoth();
    const fresh = freshApp();
    await withServer(fresh.app, async base => {
        try {
            respondCosts(500);
            const today = new Date().toISOString().slice(0, 10);
            const partial = await get(base, `/api/summary?from=${today}&to=${today}`, A);
            assert.equal(partial.body.partial, true);
            assert.equal(partial.body.orders[0].listCost, null);
            assert.equal(partial.body.shippingMissing, 2);
        } finally { restoreAdapter(); }
    });
});

// ---------- API: escrituras de precio y stock ----------
const ITEM_ID = 'MLM111001';
const liveItem = (over: any = {}) => ({
    id: ITEM_ID, title: 'Item', price: 100, available_quantity: 5, status: 'active', variations: [], ...over,
});

/** ML falso de una publicación: guarda cada PUT para comprobar exactamente qué se envió. */
const fakeItem = (item: any) => {
    const puts: any[] = [];
    axios.defaults.adapter = async (config: any) => {
        const path = new URL(config.url, 'https://api.mercadolibre.com').pathname;
        const method = String(config.method).toUpperCase();
        if (path === `/items/${ITEM_ID}`) {
            if (method === 'PUT') puts.push(JSON.parse(config.data));
            return { data: item, status: 200, statusText: 'OK', headers: {}, config };
        }
        return baseAdapter(config);
    };
    return puts;
};

const put = async (base: string, body: any) => {
    const r = await fetch(`${base}/api/items/${ITEM_ID}`, {
        method: 'PUT',
        headers: { cookie: sessionCookie(A), 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() as any };
};

test('PUT: precio o stock inválido -> 400 y nada llega a ML', async () => {
    seedBoth();
    const puts = fakeItem(liveItem());
    const { app } = freshApp();
    await withServer(app, async base => {
        try {
            const invalid = [
                { price: 0 }, { price: -1 }, { price: '100' }, { price: 100000000 },
                { available_quantity: -1 }, { available_quantity: 1.5 }, { available_quantity: '5' }, { available_quantity: 100000 },
                { variations: [{ id: 1, price: 0 }] }, { variations: [{ id: 1, available_quantity: -1 }] }, { variations: [{ id: 'x' }] },
            ];
            for (const body of invalid) {
                assert.equal((await put(base, body)).status, 400, JSON.stringify(body));
            }
            assert.equal(puts.length, 0);
        } finally { restoreAdapter(); }
    });
    assert.equal(ml.calls.filter(c => c.method === 'PUT').length, 0);
});

test('PUT: solo se envía a ML lo que cambió; sin cambios reales no hay escritura', async () => {
    seedBoth();
    const puts = fakeItem(liveItem());
    const { app } = freshApp();
    await withServer(app, async base => {
        try {
            const same = await put(base, { price: 100, available_quantity: 5 });
            assert.equal(same.status, 200);
            assert.equal(same.body.item.changed, false);
            assert.equal(puts.length, 0);

            const changed = await put(base, { price: 120, available_quantity: 5 });
            assert.equal(changed.body.item.changed, true);
            assert.deepEqual(puts, [{ price: 120 }]);
        } finally { restoreAdapter(); }
    });
});

test('PUT: precio en promoción y stock de Full bloqueados -> 409 sin escritura', async () => {
    seedBoth();
    const puts = fakeItem(liveItem({ deal_ids: ['D1'], shipping: { logistic_type: 'fulfillment' } }));
    const { app } = freshApp();
    await withServer(app, async base => {
        try {
            assert.equal((await put(base, { price: 120 })).status, 409);
            assert.equal((await put(base, { available_quantity: 9 })).status, 409);
            assert.equal(puts.length, 0);
        } finally { restoreAdapter(); }
    });
});

test('PUT: publicación finalizada bloquea precio y stock -> 409 sin escritura', async () => {
    seedBoth();
    const puts = fakeItem(liveItem({ status: 'closed' }));
    const { app } = freshApp();
    await withServer(app, async base => {
        try {
            assert.equal((await put(base, { price: 120 })).status, 409);
            assert.equal((await put(base, { available_quantity: 9 })).status, 409);
            assert.equal(puts.length, 0);
        } finally { restoreAdapter(); }
    });
});

test('PUT: variantes ajenas se rechazan y el stock general no pisa el de las variantes', async () => {
    seedBoth();
    const puts = fakeItem(liveItem({ variations: [{ id: 10, price: 100, available_quantity: 2 }, { id: 11, price: 100, available_quantity: 3 }] }));
    const { app } = freshApp();
    await withServer(app, async base => {
        try {
            assert.equal((await put(base, { variations: [{ id: 99, available_quantity: 1 }] })).status, 400);
            assert.equal((await put(base, { available_quantity: 9 })).status, 400);
            assert.equal(puts.length, 0);

            // Solo la variante que cambió, con solo el campo que cambió
            await put(base, { variations: [{ id: 10, available_quantity: 2 }, { id: 11, available_quantity: 7 }] });
            assert.deepEqual(puts, [{ variations: [{ id: 11, available_quantity: 7 }] }]);
        } finally { restoreAdapter(); }
    });
});
