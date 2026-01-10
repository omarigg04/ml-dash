import { Router, Request, Response } from 'express';
import axios from 'axios';
import { mlAuth } from '../auth/oauth';

const router = Router();

// ============================================
// CACHE SYSTEM
// ============================================

interface CacheEntry {
    data: any[];
    timestamp: number;
    sellerId: string;
}

const itemsCache = new Map<string, CacheEntry>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutos

function getCacheKey(sellerId: string, status?: string, listingType?: string): string {
    return `${sellerId}_${status || 'all'}_${listingType || 'all'}`;
}

function getFromCache(sellerId: string, status?: string, listingType?: string): any[] | null {
    const key = getCacheKey(sellerId, status, listingType);
    const cached = itemsCache.get(key);

    if (!cached) {
        return null;
    }

    const age = Date.now() - cached.timestamp;
    if (age > CACHE_TTL) {
        console.log('🗑️ Cache expired, removing:', key);
        itemsCache.delete(key);
        return null;
    }

    console.log(`✅ Cache hit! Age: ${Math.round(age / 1000)}s`);
    return cached.data;
}

function saveToCache(sellerId: string, data: any[], status?: string, listingType?: string): void {
    const key = getCacheKey(sellerId, status, listingType);
    itemsCache.set(key, {
        data,
        timestamp: Date.now(),
        sellerId
    });
    console.log(`💾 Cached ${data.length} items with key:`, key);
}

function clearItemsCache(sellerId?: string): void {
    if (sellerId) {
        // Clear only for specific seller
        const keysToDelete: string[] = [];
        itemsCache.forEach((value, key) => {
            if (value.sellerId === sellerId) {
                keysToDelete.push(key);
            }
        });
        keysToDelete.forEach(key => itemsCache.delete(key));
        console.log(`🗑️ Cleared ${keysToDelete.length} cache entries for seller:`, sellerId);
    } else {
        // Clear all
        itemsCache.clear();
        console.log('🗑️ All items cache cleared');
    }
}

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
            currency_id = 'MXN',
            available_quantity,
            buying_mode = 'buy_it_now',
            condition,
            pictures,
            description,
            listing_type_id = 'free', // Default to free listing to avoid permission issues
            warranty_type,
            warranty_time,
            sale_terms, // Términos de venta completos (incluye warranty y otros)
            attributes,
            family_name, // Required for User Products model
            shipping // Configuración de envío
        } = req.body;

        // Validate required fields (family_name OR title required)
        if (!category_id || !price || !available_quantity || !condition) {
            res.status(400).json({
                error: 'Missing required fields',
                required: ['category_id', 'price', 'available_quantity', 'condition', 'family_name OR title']
            });
            return;
        }

        // Validate that either family_name or title is provided
        if (!family_name && !title) {
            res.status(400).json({
                error: 'Missing required field',
                message: 'Either family_name (User Products) or title (Legacy) is required'
            });
            return;
        }

        // Get valid access token
        const token = await mlAuth.getToken();
        const tokenData = (mlAuth as any).tokenData;

        console.log('🔑 Token Debug Info:');
        console.log('  - Token length:', token.length);
        console.log('  - Full TOKEN:', token);
        console.log('  - Scopes granted:', tokenData?.scope || 'NO SCOPES');
        console.log('  - Has write scope:', tokenData?.scope?.includes('write') || false);

        // Prepare item data for MercadoLibre API (WITHOUT description initially)
        const itemData: any = {
            category_id,
            price: parseFloat(price),
            currency_id,
            available_quantity: parseInt(available_quantity),
            buying_mode,
            condition,
            listing_type_id, // free, bronze, silver, gold_special, gold_premium
        };

        // User Products model: Use family_name instead of title
        // When family_name is present, DO NOT send title (ML auto-generates it)
        if (family_name) {
            itemData.family_name = family_name;
        } else {
            // Legacy model: Use title
            itemData.title = title.substring(0, 60); // ML limit is 60 chars
        }

        // Add pictures if provided (max 6)
        // Frontend sends { source: "url" } objects
        if (pictures && Array.isArray(pictures) && pictures.length > 0) {
            itemData.pictures = pictures.slice(0, 6);
        }

        // Add sale_terms (warranty + otros términos de venta)
        // Si viene sale_terms completo del frontend, usarlo directamente
        if (sale_terms && Array.isArray(sale_terms) && sale_terms.length > 0) {
            itemData.sale_terms = sale_terms;
        }
        // Si no viene sale_terms pero sí warranty_type y warranty_time (legacy), construirlos
        else if (warranty_type && warranty_time) {
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

        // Add shipping configuration if provided
        if (shipping && typeof shipping === 'object') {
            // FEATURE: Convert fulfillment to xd_drop_off for duplicating fulfillment items
            // Fulfillment items cannot be duplicated/modified with fulfillment logistic_type
            // So we automatically convert to xd_drop_off (self-shipping)
            if (shipping.logistic_type === 'fulfillment') {
                console.log('🔄 Converting logistic_type from "fulfillment" to "xd_drop_off"');
                itemData.shipping = {
                    ...shipping,
                    logistic_type: 'xd_drop_off'
                };
            } else {
                itemData.shipping = shipping;
            }
        }

        console.log('📦 Creating item:', itemData.family_name || itemData.title);
        console.log('🚚 Shipping config:', JSON.stringify(itemData.shipping, null, 2));

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

        // Clear cache for this seller (new item invalidates cache)
        const userResponse = await axios.get('https://api.mercadolibre.com/users/me', {
            headers: { Authorization: `Bearer ${token}` }
        });
        clearItemsCache(userResponse.data.id);

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
        console.error('❌ Error creating item:', error.response?.data?.message || error.message);
        console.error('📊 Error Status:', error.response?.status);

        // Log validation errors summary
        if (error.response?.data?.cause) {
            const errorCount = error.response.data.cause.filter((c: any) => c.type === 'error').length;
            const warningCount = error.response.data.cause.filter((c: any) => c.type === 'warning').length;
            console.error(`📋 Validation issues: ${errorCount} errors, ${warningCount} warnings`);
            error.response.data.cause.forEach((c: any) => {
                if (c.type === 'error') {
                    console.error(`  ⚠️  ${c.code}: ${c.message}`);
                }
            });
        }

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

/**
 * GET /api/items
 * List all user's MercadoLibre items with filters, search and pagination
 *
 * Query params:
 * - offset: pagination offset (default: 0)
 * - limit: items per page (default: 50, max: 100)
 * - status: filter by status (active, paused, closed, etc.)
 * - listing_type: filter by listing type (gold_pro, gold_special, etc.)
 * - q: search query (filters items by title on frontend)
 * - sort: sort order (price_asc, price_desc, date_asc, date_desc, title_asc, title_desc)
 */
router.get('/', async (req: Request, res: Response) => {
    try {
        const token = await mlAuth.getToken();

        // Extract query parameters
        const offset = parseInt(req.query['offset'] as string) || 0;
        const limit = Math.min(parseInt(req.query['limit'] as string) || 50, 100); // Max 100
        const status = req.query['status'] as string;
        const listingType = req.query['listing_type'] as string;
        const searchQuery = (req.query['q'] as string || '').toLowerCase();
        const sortBy = req.query['sort'] as string;

        // Step 1: Get seller ID
        const userResponse = await axios.get('https://api.mercadolibre.com/users/me', {
            headers: { Authorization: `Bearer ${token}` }
        });
        const sellerId = userResponse.data.id;

        console.log('📦 Fetching items for seller:', sellerId);
        console.log('  - Offset:', offset);
        console.log('  - Limit:', limit);
        console.log('  - Status filter:', status || 'all');
        console.log('  - Listing type filter:', listingType || 'all');
        console.log('  - Search query:', searchQuery || 'none');
        console.log('  - Sort by:', sortBy || 'default');

        // Check cache first (when sorting or searching)
        if (searchQuery || sortBy) {
            console.log('🔍 Checking cache...');
            const cachedItems = getFromCache(sellerId, status, listingType);
            if (cachedItems) {
                console.log('✅ Using cached items!');
                let filteredItems = cachedItems;

                // Apply search filter
                if (searchQuery) {
                    filteredItems = cachedItems.filter(item =>
                        item.title.toLowerCase().includes(searchQuery) ||
                        item.id.toLowerCase().includes(searchQuery)
                    );
                    console.log(`  - Filtered to ${filteredItems.length} items matching search query`);
                }

                // Apply sorting
                if (sortBy) {
                    filteredItems.sort((a, b) => {
                        switch (sortBy) {
                            case 'price_asc': return a.price - b.price;
                            case 'price_desc': return b.price - a.price;
                            case 'date_asc': return new Date(a.date_created).getTime() - new Date(b.date_created).getTime();
                            case 'date_desc': return new Date(b.date_created).getTime() - new Date(a.date_created).getTime();
                            case 'title_asc': return a.title.localeCompare(b.title);
                            case 'title_desc': return b.title.localeCompare(a.title);
                            case 'stock_asc': return a.available_quantity - b.available_quantity;
                            case 'stock_desc': return b.available_quantity - a.available_quantity;
                            case 'sales_asc': return (a.sold_quantity || 0) - (b.sold_quantity || 0);
                            case 'sales_desc': return (b.sold_quantity || 0) - (a.sold_quantity || 0);
                            default: return 0;
                        }
                    });
                }

                // Apply pagination
                const start = offset;
                const end = offset + limit;
                const paginatedItems = filteredItems.slice(start, end);

                return res.json({
                    items: paginatedItems,
                    paging: {
                        total: filteredItems.length,
                        offset: offset,
                        limit: limit
                    },
                    filters: {
                        status: status || null,
                        listing_type: listingType || null,
                        search: searchQuery || null,
                        sort: sortBy || null
                    },
                    cached: true
                });
            }
            console.log('❌ Cache miss, fetching from ML API...');
        }

        // Step 2: Build params for ML API
        const mlParams: any = {
            offset,
            limit
        };

        if (status) {
            mlParams.status = status;
        }

        if (listingType) {
            mlParams.listing_type_id = listingType;
        }

        // Step 3: Get items list
        let itemsResponse;
        let itemIds: string[] = [];
        let totalItems = 0;

        // Fetch ALL items when searching OR sorting (to ensure correct order)
        if (searchQuery || sortBy) {
            if (searchQuery) {
                console.log('  - Search mode: fetching all items for comprehensive search');
            } else if (sortBy) {
                console.log('  - Sort mode: fetching all items to ensure correct order');
            }

            const batchSize = 100; // ML API max limit per request
            let currentOffset = 0;
            let firstBatch = true;

            // First request to get total count
            while (true) {
                const fetchParams: any = {
                    offset: currentOffset,
                    limit: batchSize
                };

                if (status) {
                    fetchParams.status = status;
                }

                if (listingType) {
                    fetchParams.listing_type_id = listingType;
                }

                const batchResponse = await axios.get(
                    `https://api.mercadolibre.com/users/${sellerId}/items/search`,
                    {
                        headers: { Authorization: `Bearer ${token}` },
                        params: fetchParams
                    }
                );

                const batchIds = batchResponse.data.results;
                itemIds.push(...batchIds);

                // Get total from first batch
                if (firstBatch) {
                    totalItems = batchResponse.data.paging.total;
                    console.log(`  - Total items to fetch: ${totalItems}`);
                    firstBatch = false;
                }

                console.log(`  - Fetched batch at offset ${currentOffset}: ${batchIds.length} items (${itemIds.length}/${totalItems})`);

                // Store the last response for paging info
                itemsResponse = batchResponse;

                // Check if we've fetched all items
                if (batchIds.length < batchSize || itemIds.length >= totalItems) {
                    break;
                }

                currentOffset += batchSize;
            }

            console.log(`  - ✅ Fetched all ${itemIds.length} items for search`);
        } else {
            // Normal mode: single request with pagination
            const fetchParams: any = {
                offset,
                limit
            };

            if (status) {
                fetchParams.status = status;
            }

            if (listingType) {
                fetchParams.listing_type_id = listingType;
            }

            itemsResponse = await axios.get(
                `https://api.mercadolibre.com/users/${sellerId}/items/search`,
                {
                    headers: { Authorization: `Bearer ${token}` },
                    params: fetchParams
                }
            );

            itemIds = itemsResponse.data.results;
        }

        console.log(`✅ Found ${itemIds.length} items (total: ${itemsResponse.data.paging.total})`);

        if (itemIds.length === 0) {
            return res.json({
                items: [],
                paging: itemsResponse.data.paging,
                filters: {
                    status: status || null,
                    listing_type: listingType || null,
                    search: searchQuery || null,
                    sort: sortBy || null
                }
            });
        }

        // Step 4: Fetch detailed info for items (ML allows up to 20 at once)
        // If more than 20, split into batches
        const batchSize = 20;
        const batches = [];

        for (let i = 0; i < itemIds.length; i += batchSize) {
            const batchIds = itemIds.slice(i, i + batchSize);
            batches.push(batchIds);
        }

        const allItems = [];

        for (const batchIds of batches) {
            const detailsResponse = await axios.get(
                `https://api.mercadolibre.com/items?ids=${batchIds.join(',')}`,
                { headers: { Authorization: `Bearer ${token}` } }
            );

            const batchItems = detailsResponse.data
                .filter((item: any) => item.code === 200) // Only successful responses
                .map((item: any) => ({
                    id: item.body.id,
                    title: item.body.title,
                    price: item.body.price,
                    available_quantity: item.body.available_quantity,
                    sold_quantity: item.body.sold_quantity || 0,
                    status: item.body.status,
                    thumbnail: item.body.thumbnail || item.body.pictures?.[0]?.url || null,
                    listing_type_id: item.body.listing_type_id,
                    condition: item.body.condition,
                    permalink: item.body.permalink,
                    date_created: item.body.date_created,
                    last_updated: item.body.last_updated,
                    // Include full data for duplicate feature
                    fullData: item.body
                }));

            allItems.push(...batchItems);
        }

        // Save to cache (only when fetching all items for sorting/searching)
        if (searchQuery || sortBy) {
            saveToCache(sellerId, allItems, status, listingType);
        }

        // Step 5: Apply search filter (if searching)
        let filteredItems = allItems;

        if (searchQuery) {
            filteredItems = allItems.filter(item =>
                item.title.toLowerCase().includes(searchQuery) ||
                item.id.toLowerCase().includes(searchQuery)
            );
            console.log(`  - Filtered to ${filteredItems.length} items matching search query`);
        }

        // Step 6: Apply sorting
        if (sortBy) {
            filteredItems.sort((a, b) => {
                switch (sortBy) {
                    case 'price_asc':
                        return a.price - b.price;
                    case 'price_desc':
                        return b.price - a.price;
                    case 'date_asc':
                        return new Date(a.date_created).getTime() - new Date(b.date_created).getTime();
                    case 'date_desc':
                        return new Date(b.date_created).getTime() - new Date(a.date_created).getTime();
                    case 'title_asc':
                        return a.title.localeCompare(b.title);
                    case 'title_desc':
                        return b.title.localeCompare(a.title);
                    case 'stock_asc':
                        return a.available_quantity - b.available_quantity;
                    case 'stock_desc':
                        return b.available_quantity - a.available_quantity;
                    case 'sales_asc':
                        return (a.sold_quantity || 0) - (b.sold_quantity || 0);
                    case 'sales_desc':
                        return (b.sold_quantity || 0) - (a.sold_quantity || 0);
                    default:
                        return 0;
                }
            });
        }

        // Step 7: Apply client-side pagination (when searching or sorting)
        let paginatedItems = filteredItems;
        let adjustedPaging = itemsResponse.data.paging;

        if (searchQuery || sortBy) {
            // Manual pagination for search/sorted results
            const start = offset;
            const end = offset + limit;
            paginatedItems = filteredItems.slice(start, end);

            adjustedPaging = {
                total: filteredItems.length,
                offset: offset,
                limit: limit
            };

            const mode = searchQuery ? 'search' : 'sorted';
            console.log(`  - Paginated: showing ${start}-${end} of ${filteredItems.length} ${mode} results`);
        }

        res.json({
            items: paginatedItems,
            paging: adjustedPaging,
            filters: {
                status: status || null,
                listing_type: listingType || null,
                search: searchQuery || null,
                sort: sortBy || null
            }
        });

    } catch (error: any) {
        console.error('❌ Error fetching items:', error.response?.data || error.message);
        res.status(500).json({
            error: 'Failed to fetch items',
            details: error.response?.data || error.message
        });
    }
});

/**
 * GET /api/items/visits
 * Get visit counts for multiple items
 * Query params:
 * - ids: comma-separated list of item IDs (e.g., "MLM123,MLM456,MLM789")
 *
 * Note: ML API only allows fetching visits for ONE item at a time,
 * so we make individual requests and combine the results
 *
 * IMPORTANT: This route MUST be before /:id routes to avoid route conflicts
 */
router.get('/visits', async (req: Request, res: Response) => {
    try {
        const idsParam = req.query['ids'] as string;

        if (!idsParam) {
            return res.status(400).json({
                error: 'Missing required parameter: ids'
            });
        }

        // Split and validate IDs
        const ids = idsParam.split(',').map(id => id.trim()).filter(id => id.length > 0);

        if (ids.length === 0) {
            return res.status(400).json({
                error: 'No valid item IDs provided'
            });
        }

        // Limit to prevent too many requests
        if (ids.length > 100) {
            return res.status(400).json({
                error: 'Too many IDs. Maximum 100 items per request.'
            });
        }

        // Get access token for authentication
        const token = await mlAuth.getToken();

        // Object to store all visit counts
        const visitsData: { [key: string]: number } = {};

        // Fetch visits for each item individually
        // ML API only allows one item at a time: /visits/items?ids=MLM123
        const promises = ids.map(async (itemId) => {
            try {
                const response = await axios.get(
                    `https://api.mercadolibre.com/visits/items?ids=${itemId}`,
                    {
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Content-Type': 'application/json'
                        }
                    }
                );

                // Response format: { "MLM123": 42 }
                const visitCount = response.data[itemId];
                visitsData[itemId] = visitCount !== undefined ? visitCount : 0;
            } catch (error: any) {
                // If fails, set to 0
                visitsData[itemId] = 0;
            }
        });

        // Wait for all requests to complete
        await Promise.all(promises);

        // Return combined results in same format: { "MLM123": 42, "MLM456": 15, ... }
        res.json(visitsData);

    } catch (error: any) {
        console.error('❌ Error fetching visit counts:', error.message);
        res.status(500).json({
            error: 'Failed to fetch visit counts',
            details: error.message
        });
    }
});

/**
 * GET /api/items/:id/description
 * Get description for an item
 */
router.get('/:id/description', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const token = await mlAuth.getToken();

        console.log(`📄 Fetching description for item ${id}`);

        const response = await axios.get(
            `https://api.mercadolibre.com/items/${id}/description`,
            {
                headers: {
                    Authorization: `Bearer ${token}`
                }
            }
        );

        console.log('✅ Description fetched successfully');

        res.json(response.data);

    } catch (error: any) {
        console.error('❌ Error fetching description:', error.response?.data || error.message);

        // If description doesn't exist, return empty
        if (error.response?.status === 404) {
            return res.json({
                plain_text: '',
                text: ''
            });
        }

        res.status(500).json({
            error: 'Failed to fetch description',
            details: error.response?.data || error.message
        });
    }
});

/**
 * POST /api/items/:id/relist
 * Republish a closed item
 */
router.post('/:id/relist', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const { price, quantity, listing_type_id } = req.body;

        if (!price || !quantity || !listing_type_id) {
            return res.status(400).json({
                error: 'Missing required fields: price, quantity, listing_type_id'
            });
        }

        const token = await mlAuth.getToken();

        console.log(`🔄 Relisting item ${id} with price: ${price}, quantity: ${quantity}`);

        const response = await axios.post(
            `https://api.mercadolibre.com/items/${id}/relist`,
            {
                price: parseFloat(price),
                quantity: parseInt(quantity),
                listing_type_id
            },
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        console.log('✅ Item relisted successfully. New ID:', response.data.id);

        res.json({
            success: true,
            message: 'Item relisted successfully',
            newItem: response.data
        });

    } catch (error: any) {
        console.error('❌ Error relisting item:', error.response?.data || error.message);
        res.status(500).json({
            error: 'Failed to relist item',
            details: error.response?.data || error.message
        });
    }
});

export default router;
