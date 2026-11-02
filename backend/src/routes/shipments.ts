import { Router, Request, Response } from 'express';
import axios from 'axios';
import { mlAuth } from '../auth/oauth';
import { MLShipment, MLShipmentCosts } from '../types';

const router = Router();

/**
 * GET /api/shipments/:id
 * Fetch shipment details by ID
 */
router.get('/:id', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;

        if (!id) {
            res.status(400).json({ error: 'Shipment ID is required' });
            return;
        }

        // Get valid access token
        const token = await mlAuth.getToken();

        // Fetch shipment details
        const shipmentResponse = await axios.get<MLShipment>(
            `https://api.mercadolibre.com/shipments/${encodeURIComponent(id)}`,
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                },
            }
        );

        const shipment = shipmentResponse.data;

        // Lo que el vendedor paga por el envío. list_cost ya no viene en la raíz del
        // shipment (está en shipping_option); el dato exacto es senders[].cost de /costs.
        let sellerCost: number | null = null;
        try {
            const costsResponse = await axios.get<MLShipmentCosts>(
                `https://api.mercadolibre.com/shipments/${encodeURIComponent(id)}/costs`,
                { headers: { Authorization: `Bearer ${token}` } }
            );
            const senders = costsResponse.data.senders || [];
            if (senders.length) {
                sellerCost = senders.reduce((sum, s) => sum + (s.cost || 0), 0);
            }
        } catch (costError: any) {
            console.warn(`Shipment ${id} costs unavailable:`, costError.response?.status || costError.message);
        }
        const listCost = sellerCost ?? shipment.shipping_option?.list_cost ?? shipment.list_cost ?? 0;

        // Return shipment data with cost information
        res.json({
            id: shipment.id,
            order_id: shipment.order_id,
            listCost,
            orderCost: shipment.order_cost || 0,
            status: shipment.status,
        });
    } catch (error: any) {
        console.error(`Error fetching shipment ${req.params['id']}:`, error.response?.data || error.message);

        if (error.message?.includes('No token available')) {
            res.status(401).json({
                error: 'Not authorized',
                message: 'Please authorize the app first by visiting /auth',
            });
            return;
        }

        if (error.response?.status === 404) {
            res.status(404).json({
                error: 'Shipment not found',
                message: `Shipment with ID ${req.params['id']} not found`,
            });
            return;
        }

        res.status(500).json({
            error: 'Failed to fetch shipment',
            message: error.response?.data?.message || error.message,
        });
    }
});

export default router;
