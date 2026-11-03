import { Router, Request, Response } from 'express';
import axios from 'axios';
import { mlAuth } from '../auth/oauth';
import { safeError } from '../security';
import { MLOrder } from '../types';

const router = Router();

/**
 * Minimización de datos personales: solo los campos de la orden que usa la UI (Órdenes y
 * análisis). Del comprador solo viaja el nickname; no se envían teléfono, nombre, facturación,
 * domicilio ni feedback.
 */
function toClientOrder(o: any): any {
    const buyer = o?.buyer;
    return {
        id: o?.id,
        status: o?.status,
        status_detail: o?.status_detail,
        date_created: o?.date_created,
        date_closed: o?.date_closed,
        fulfilled: o?.fulfilled,
        tags: o?.tags,
        total_amount: o?.total_amount,
        paid_amount: o?.paid_amount,
        currency_id: o?.currency_id,
        shipping: o?.shipping?.id != null ? { id: o.shipping.id } : undefined,
        buyer: buyer ? { nickname: buyer.nickname } : undefined,
        order_items: (o?.order_items || []).map((oi: any) => ({
            item: { id: oi?.item?.id, title: oi?.item?.title },
            quantity: oi?.quantity,
            unit_price: oi?.unit_price,
            sale_fee: oi?.sale_fee,
            listing_type_id: oi?.listing_type_id,
        })),
        payments: (o?.payments || []).map((p: any) => ({
            id: p?.id,
            status: p?.status,
            payment_method_id: p?.payment_method_id,
            payment_type: p?.payment_type,
            total_paid_amount: p?.total_paid_amount,
            transaction_amount: p?.transaction_amount,
            installments: p?.installments,
            date_approved: p?.date_approved,
        })),
    };
}


/**
 * GET /api/orders
 * Fetch orders from MercadoLibre API with optional date filtering
 *
 * Query params:
 * - from: ISO 8601 date string (e.g., "2025-12-01T00:00:00.000Z")
 * - to: ISO 8601 date string (e.g., "2025-12-31T23:59:59.999Z")
 */
router.get('/', async (req: Request, res: Response) => {
    try {
        const { from, to } = req.query;

        // Validate date parameters if provided
        if (from && typeof from !== 'string') {
            return res.status(400).json({
                error: 'Invalid parameter',
                message: 'from must be a valid ISO 8601 date string'
            });
        }

        if (to && typeof to !== 'string') {
            return res.status(400).json({
                error: 'Invalid parameter',
                message: 'to must be a valid ISO 8601 date string'
            });
        }

        // Validate that from is before to
        if (from && to) {
            const fromDate = new Date(String(from));
            const toDate = new Date(String(to));

            if (isNaN(fromDate.getTime())) {
                return res.status(400).json({
                    error: 'Invalid date format',
                    message: 'from is not a valid date'
                });
            }

            if (isNaN(toDate.getTime())) {
                return res.status(400).json({
                    error: 'Invalid date format',
                    message: 'to is not a valid date'
                });
            }

            if (fromDate >= toDate) {
                return res.status(400).json({
                    error: 'Invalid date range',
                    message: 'from must be before to'
                });
            }

            // Validate max range (365 days)
            const diffTime = toDate.getTime() - fromDate.getTime();
            const diffDays = diffTime / (1000 * 60 * 60 * 24);

            if (diffDays > 365) {
                return res.status(400).json({
                    error: 'Date range too large',
                    message: 'Maximum date range is 365 days'
                });
            }
        }

        // Get valid access token
        const token = await mlAuth.getToken();

        // Get seller ID from token data
        const sellerResponse = await axios.get('https://api.mercadolibre.com/users/me', {
            headers: {
                Authorization: `Bearer ${token}`,
            },
        });

        const sellerId = sellerResponse.data.id;

        // Build API parameters
        const apiParams: any = {
            sort: 'date_desc',
            limit: 50, // Max per request
        };

        // Add date filters if provided
        if (from) {
            apiParams['order.date_created.from'] = from;
        }

        if (to) {
            apiParams['order.date_created.to'] = to;
        }

        console.log('📅 Fetching orders with params:', apiParams);

        // Fetch orders from MercadoLibre (with pagination support)
        let allOrders: MLOrder[] = [];
        let offset = 0;
        let hasMore = true;

        while (hasMore) {
            const ordersResponse = await axios.get(
                `https://api.mercadolibre.com/orders/search?seller=${encodeURIComponent(String(sellerId))}`,
                {
                    headers: {
                        Authorization: `Bearer ${token}`,
                    },
                    params: {
                        ...apiParams,
                        offset,
                    },
                }
            );

            const orders: MLOrder[] = ordersResponse.data.results || [];
            allOrders = allOrders.concat(orders);

            console.log(`📦 Fetched ${orders.length} orders (offset: ${offset}, total so far: ${allOrders.length})`);

            // Check if there are more orders to fetch
            const paging = ordersResponse.data.paging;
            hasMore = paging && (offset + paging.limit < paging.total);
            offset += paging?.limit || 50;

            // Safety limit to avoid infinite loops
            if (offset > 10000) {
                console.warn('⚠️ Reached safety limit of 10,000 orders');
                break;
            }
        }

        console.log(`✅ Total orders fetched: ${allOrders.length}`);

        // Fetch detailed information for each order
        const detailedOrders = await Promise.all(
            allOrders.map(async (order) => {
                try {
                    const orderDetail = await axios.get(
                        `https://api.mercadolibre.com/orders/${encodeURIComponent(String(order.id))}`,
                        {
                            headers: {
                                Authorization: `Bearer ${token}`,
                            },
                        }
                    );
                    return toClientOrder(orderDetail.data);
                } catch (error) {
                    console.error(`Error fetching order ${order.id}:`, safeError(error));
                    return toClientOrder(order); // Return basic order if detail fetch fails
                }
            })
        );

        res.json(detailedOrders);
    } catch (error: any) {
        console.error('Error fetching orders:', error.response?.data || error.message);

        if (error.message?.includes('No token available')) {
            res.status(401).json({
                error: 'Not authorized',
                message: 'Please authorize the app first by visiting /auth',
            });
            return;
        }

        res.status(500).json({
            error: 'Failed to fetch orders',
            message: error.response?.data?.message || error.message,
        });
    }
});

export default router;
