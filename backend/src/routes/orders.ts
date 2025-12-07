import { Router, Request, Response } from 'express';
import axios from 'axios';
import { mlAuth } from '../auth/oauth';
import { MLOrder } from '../types';

const router = Router();

/**
 * GET /api/orders
 * Fetch all orders from MercadoLibre API
 */
router.get('/', async (req: Request, res: Response) => {
    try {
        // Get valid access token
        const token = await mlAuth.getToken();

        // Get seller ID from token data
        const sellerResponse = await axios.get('https://api.mercadolibre.com/users/me', {
            headers: {
                Authorization: `Bearer ${token}`,
            },
        });

        const sellerId = sellerResponse.data.id;

        // Fetch orders from MercadoLibre
        // Note: You can add query parameters like offset, limit, sort, etc.
        const ordersResponse = await axios.get(
            `https://api.mercadolibre.com/orders/search?seller=${sellerId}`,
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                },
                params: {
                    sort: 'date_desc',
                    ...req.query, // Pass any query params from the frontend
                },
            }
        );

        const orders: MLOrder[] = ordersResponse.data.results;

        // Fetch detailed information for each order
        const detailedOrders = await Promise.all(
            orders.map(async (order) => {
                try {
                    const orderDetail = await axios.get(
                        `https://api.mercadolibre.com/orders/${order.id}`,
                        {
                            headers: {
                                Authorization: `Bearer ${token}`,
                            },
                        }
                    );
                    return orderDetail.data;
                } catch (error) {
                    console.error(`Error fetching order ${order.id}:`, error);
                    return order; // Return basic order if detail fetch fails
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
