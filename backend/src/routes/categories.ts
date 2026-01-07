import { Router, Request, Response } from 'express';
import axios from 'axios';
import { mlAuth } from '../auth/oauth';

const router = Router();

/**
 * GET /api/categories/predict
 * Predict category based on product title/name
 *
 * Query params:
 * - q: Product title/name to predict category for
 * - limit: Number of predictions (1-8, default: 3)
 */
router.get('/predict', async (req: Request, res: Response) => {
    console.log('\n🎯 ============================================');
    console.log('📥 [CATEGORIES/PREDICT] Request received');
    console.log('  - Query params:', req.query);
    console.log('  - URL:', req.url);
    console.log('============================================\n');

    try {
        const query = req.query.q as string;
        const limit = parseInt(req.query.limit as string) || 3;

        console.log('🔍 Processing prediction request:');
        console.log('  - Query:', query);
        console.log('  - Limit:', limit);

        if (!query || query.trim().length === 0) {
            console.log('❌ Missing query parameter');
            res.status(400).json({
                error: 'Missing query parameter',
                message: 'Please provide "q" parameter with product title/name'
            });
            return;
        }

        console.log('🔑 Getting ML token...');
        const token = await mlAuth.getToken();
        console.log('✅ Token obtained');

        console.log('🔍 Calling ML API for prediction...');
        console.log('  - Query:', query);
        console.log('  - Limit:', limit);

        // Call MercadoLibre domain discovery API
        const response = await axios.get(
            `https://api.mercadolibre.com/sites/MLM/domain_discovery/search`,
            {
                headers: {
                    Authorization: `Bearer ${token}`
                },
                params: {
                    q: query,
                    limit: Math.min(Math.max(limit, 1), 8) // Clamp between 1-8
                }
            }
        );

        const predictions = response.data;

        // Format response to include relevant information
        const formattedPredictions = predictions.map((pred: any) => ({
            domain_id: pred.domain_id,
            domain_name: pred.domain_name,
            category_id: pred.category_id,
            category_name: pred.category_name,
            attributes: pred.attributes || []
        }));

        console.log(`\n✅ ML API Response received`);
        console.log(`  - Found ${predictions.length} predictions`);
        console.log(`  - Categories: ${formattedPredictions.map(p => p.category_name).join(', ')}`);
        console.log(`  - Attributes modified: Formatted ${formattedPredictions.reduce((acc, p) => acc + p.attributes.length, 0)} total attributes`);
        console.log('============================================\n');

        res.json({
            query: query,
            predictions: formattedPredictions,
            total: formattedPredictions.length
        });

    } catch (error: any) {
        console.error('\n❌ ============================================');
        console.error('❌ [CATEGORIES/PREDICT] Error occurred');
        console.error('  - Error:', error.message);
        console.error('  - Status:', error.response?.status);
        console.error('  - Data:', error.response?.data);
        console.error('============================================\n');

        if (error.response?.status === 401) {
            res.status(401).json({
                error: 'Unauthorized',
                message: 'Access token is invalid or expired. Please re-authorize the app.'
            });
            return;
        }

        res.status(500).json({
            error: 'Failed to predict category',
            message: error.response?.data?.message || error.message,
            details: error.response?.data
        });
    }
});

/**
 * GET /api/categories/:id/attributes
 * Get attributes for a specific category
 */
router.get('/:id/attributes', async (req: Request, res: Response) => {
    console.log('\n📋 ============================================');
    console.log('📥 [CATEGORIES/ATTRIBUTES] Request received');
    console.log('  - Category ID:', req.params.id);
    console.log('============================================\n');

    try {
        const categoryId = req.params.id;

        console.log('🔑 Getting ML token...');
        const token = await mlAuth.getToken();
        console.log('✅ Token obtained');

        console.log('🔍 Calling ML API for category attributes...');
        console.log('  - Category ID:', categoryId);

        const response = await axios.get(
            `https://api.mercadolibre.com/categories/${categoryId}/attributes`,
            {
                headers: {
                    Authorization: `Bearer ${token}`
                }
            }
        );

        const attributes = response.data;

        console.log(`\n✅ ML API Response received`);
        console.log(`  - Found ${attributes.length} attributes for category ${categoryId}`);

        console.log(`\n📤 Sending ${attributes.length} attributes to client`);
        console.log('============================================\n');

        res.json(attributes);

    } catch (error: any) {
        console.error('\n❌ ============================================');
        console.error('❌ [CATEGORIES/ATTRIBUTES] Error occurred');
        console.error('  - Error:', error.message);
        console.error('  - Status:', error.response?.status);
        console.error('  - Data:', error.response?.data);
        console.error('============================================\n');

        if (error.response?.status === 401) {
            res.status(401).json({
                error: 'Unauthorized',
                message: 'Access token is invalid or expired. Please re-authorize the app.'
            });
            return;
        }

        if (error.response?.status === 404) {
            res.status(404).json({
                error: 'Category not found',
                message: `Category with ID ${req.params.id} does not exist or has no attributes`
            });
            return;
        }

        res.status(500).json({
            error: 'Failed to fetch category attributes',
            message: error.response?.data?.message || error.message,
            details: error.response?.data
        });
    }
});

/**
 * GET /api/categories/:id
 * Get detailed information about a specific category
 */
router.get('/:id', async (req: Request, res: Response) => {
    try {
        const categoryId = req.params.id;
        const token = await mlAuth.getToken();

        console.log('📋 Fetching category details for:', categoryId);

        const response = await axios.get(
            `https://api.mercadolibre.com/categories/${categoryId}`,
            {
                headers: {
                    Authorization: `Bearer ${token}`
                }
            }
        );

        console.log('✅ Category details fetched');

        res.json(response.data);

    } catch (error: any) {
        console.error('❌ Error fetching category:', error.response?.data || error.message);

        if (error.response?.status === 404) {
            res.status(404).json({
                error: 'Category not found',
                message: `Category with ID ${req.params.id} does not exist`
            });
            return;
        }

        res.status(500).json({
            error: 'Failed to fetch category',
            message: error.response?.data?.message || error.message
        });
    }
});

export default router;
