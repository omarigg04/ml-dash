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
            description,
            listing_type_id = 'free', // Default to free listing to avoid permission issues
            warranty_type,
            warranty_time,
            attributes
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
        console.log('🔑 Using token to create item (length):', token.length);

        // Prepare item data for MercadoLibre API (WITHOUT description initially)
        const itemData: any = {
            title: title.substring(0, 60), // ML limit is 60 chars
            category_id,
            price: parseFloat(price),
            currency_id: 'MXN',
            available_quantity: parseInt(available_quantity),
            buying_mode: 'buy_it_now',
            condition,
            listing_type_id, // free, bronze, silver, gold_special, gold_premium
        };

        // Add pictures if provided (max 6)
        if (pictures && Array.isArray(pictures) && pictures.length > 0) {
            itemData.pictures = pictures.slice(0, 6).map((url: string) => ({ source: url }));
        }

        // Add warranty information if provided
        if (warranty_type && warranty_time) {
            itemData.sale_terms = [
                {
                    id: 'WARRANTY_TYPE',
                    value_name: warranty_type // 'Garantía del vendedor' or 'Sin garantía'
                },
                {
                    id: 'WARRANTY_TIME',
                    value_name: warranty_time // '90 días', '6 meses', '1 año', etc.
                }
            ];
        }

        // Add attributes if provided (brand, model, etc.)
        if (attributes && Array.isArray(attributes) && attributes.length > 0) {
            itemData.attributes = attributes;
        }

        console.log('📦 Creating item with data:', JSON.stringify(itemData, null, 2));

        // Step 1: Create item on MercadoLibre (WITHOUT description)
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

        const itemId = response.data.id;
        console.log('✅ Item created successfully with ID:', itemId);

        // Step 2: Add description AFTER item creation (if provided)
        if (description && description.trim()) {
            try {
                await axios.post(
                    `https://api.mercadolibre.com/items/${itemId}/description`,
                    {
                        plain_text: description
                    },
                    {
                        headers: {
                            Authorization: `Bearer ${token}`,
                            'Content-Type': 'application/json',
                        },
                    }
                );
                console.log('✅ Description added successfully');
            } catch (descError: any) {
                console.error('⚠️  Error adding description:', descError.response?.data);
                // Don't fail the whole request if description fails
            }
        }

        res.status(201).json({
            success: true,
            item: response.data,
            message: 'Product published successfully',
        });
    } catch (error: any) {
        console.error('❌ Error creating item:', error.response?.data || error.message);
        console.error('📊 Error Status:', error.response?.status);
        console.error('📋 Full error response:', JSON.stringify(error.response?.data, null, 2));

        if (error.message?.includes('No token available')) {
            res.status(401).json({
                error: 'Not authorized',
                message: 'Please authorize the app first by visiting /api/auth',
            });
            return;
        }

        // Check for scope errors
        if (error.response?.data?.message?.includes('scopes') ||
            error.response?.data?.error?.includes('scopes')) {
            res.status(403).json({
                error: 'Unauthorized scopes',
                message: 'Your app does not have permission to create items. Please re-authorize by visiting /api/auth',
                details: error.response.data,
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
