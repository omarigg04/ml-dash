import { Router, Request, Response } from 'express';
import axios from 'axios';
import { mlAuth } from '../auth/oauth';

const router = Router();

/**
 * POST /api/items
 * Create a new product listing on MercadoLibre
 */
router.post('/', async (req: Request, res: Response) => {
    try {
        const {
            title,
            category_id,
            price,
            available_quantity,
            condition,
            pictures,
            description
        } = req.body;

        // Validate required fields
        if (!title || !category_id || !price || !available_quantity || !condition) {
            res.status(400).json({
                error: 'Missing required fields',
                required: ['title', 'category_id', 'price', 'available_quantity', 'condition']
            });
            return;
        }

        // Get valid access token
        const token = await mlAuth.getToken();

        // Prepare item data for MercadoLibre API
        const itemData: any = {
            title: title.substring(0, 60), // ML limit is 60 chars
            category_id,
            price: parseFloat(price),
            currency_id: 'MXN',
            available_quantity: parseInt(available_quantity),
            buying_mode: 'buy_it_now',
            condition,
            listing_type_id: 'gold_special',
        };

        // Add pictures if provided
        if (pictures && Array.isArray(pictures) && pictures.length > 0) {
            itemData.pictures = pictures.map((url: string) => ({ source: url }));
        }

        // Add description if provided
        if (description) {
            itemData.description = {
                plain_text: description
            };
        }

        // Create item on MercadoLibre
        const response = await axios.post(
            'https://api.mercadolibre.com/items',
            itemData,
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
            }
        );

        res.status(201).json({
            success: true,
            item: response.data,
            message: 'Product published successfully',
        });
    } catch (error: any) {
        console.error('Error creating item:', error.response?.data || error.message);

        if (error.message?.includes('No token available')) {
            res.status(401).json({
                error: 'Not authorized',
                message: 'Please authorize the app first by visiting /auth',
            });
            return;
        }

        if (error.response?.status === 400) {
            res.status(400).json({
                error: 'Invalid item data',
                details: error.response.data,
            });
            return;
        }

        res.status(500).json({
            error: 'Failed to create item',
            message: error.response?.data?.message || error.message,
        });
    }
});

export default router;
