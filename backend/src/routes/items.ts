import { Router, Request, Response } from 'express';
import axios from 'axios';
import { mlAuth } from '../auth/oauth';
import { ITEM_ID_RE, CATEGORY_ID_RE, safeError } from '../security';

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

// ============================================
// HELPERS (validación de ids y errores de ML)
// ============================================

const ML_API = 'https://api.mercadolibre.com';

interface ErrorCause {
    code: string;
    message: string;
    type?: string;
}

/** Normaliza el error de axios/ML a { error, status, causes[] } conservando el status de ML. */
function mlErrorResponse(error: any, fallback: string): { status: number; body: any } {
    if (error?.message?.includes('No token available')) {
        return {
            status: 401,
            body: { error: 'No autorizado: autoriza la app con MercadoLibre primero', status: 401, causes: [] }
        };
    }
    const status: number = error?.response?.status || 500;
    const data = error?.response?.data;
    const causes: ErrorCause[] = Array.isArray(data?.cause)
        ? data.cause.map((c: any) => ({
            code: String(c?.code ?? c?.type ?? 'error'),
            message: String(c?.message ?? c?.code ?? ''),
            type: c?.type
        }))
        : [];
    const message = data?.message || data?.error || error?.message || fallback;
    return { status, body: { error: message, status, causes } };
}

/** Construye el body de ML a partir de lo que manda el formulario. Solo copia campos conocidos. */
function buildItemData(input: any): any {
    const {
        title, category_id, price, currency_id = 'MXN', available_quantity,
        buying_mode = 'buy_it_now', condition, pictures, listing_type_id = 'gold_special',
        sale_terms, attributes, family_name, shipping
    } = input;

    const itemData: any = {
        category_id,
        price: parseFloat(price),
        currency_id,
        available_quantity: parseInt(available_quantity),
        buying_mode,
        condition,
        listing_type_id,
    };

    // Vendedores User Products: solo family_name (ML genera el título). Legacy: title.
    if (family_name) {
        itemData.family_name = String(family_name);
    } else if (title) {
        itemData.title = String(title).substring(0, 60);
    }

    // Fotos: { id } (ya alojadas en ML) o { source } (URL). El límite por categoría lo valida ML.
    if (Array.isArray(pictures) && pictures.length > 0) {
        itemData.pictures = pictures
            .map((p: any) => (p?.id ? { id: p.id } : p?.source ? { source: p.source } : null))
            .filter(Boolean);
    }

    if (Array.isArray(sale_terms) && sale_terms.length > 0) {
        itemData.sale_terms = sale_terms;
    }

    if (Array.isArray(attributes) && attributes.length > 0) {
        itemData.attributes = attributes;
    }

    // Envío: solo los campos que ML acepta del vendedor. logistic_type/tags/methods los asigna ML.
    if (shipping && typeof shipping === 'object') {
        const s: any = {};
        if (shipping.mode) s.mode = shipping.mode;
        if (typeof shipping.local_pick_up === 'boolean') s.local_pick_up = shipping.local_pick_up;
        if (typeof shipping.free_shipping === 'boolean') s.free_shipping = shipping.free_shipping;
        if (Object.keys(s).length > 0) itemData.shipping = s;
    }

    return itemData;
}

function validateBasicFields(body: any): string | null {
    if (!body?.category_id || !body?.price || !body?.condition) {
        return 'Faltan campos obligatorios: category_id, price, condition';
    }
    if (body.available_quantity === undefined || body.available_quantity === null || Number(body.available_quantity) < 1) {
        return 'La cantidad disponible debe ser al menos 1';
    }
    if (!body.family_name && !body.title) {
        return 'Se requiere family_name (User Products) o title (legacy)';
    }
    return null;
}

async function postDescription(token: string, itemId: string, text: string): Promise<void> {
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    try {
        await axios.post(`${ML_API}/items/${itemId}/description`, { plain_text: text }, { headers });
    } catch (err: any) {
        // Si ya existe una descripción, ML responde 400: se reemplaza con PUT.
        if (err.response?.status === 400) {
            await axios.put(`${ML_API}/items/${itemId}/description?api_version=2`, { plain_text: text }, { headers });
            return;
        }
        throw err;
    }
}

/**
 * POST /api/items/validate
 * Valida el payload contra ML (/items/validate) SIN publicar.
 * Responde 200 con { valid, status, errors[], warnings[] } cuando ML contesta;
 * valid = ML no devolvió ninguna causa de tipo error (204 o solo advertencias).
 */
router.post('/validate', async (req: Request, res: Response) => {
    const basic = validateBasicFields(req.body);
    if (basic) {
        res.status(400).json({ error: basic, status: 400, causes: [{ code: 'missing_fields', message: basic }] });
        return;
    }
    try {
        const token = await mlAuth.getToken();
        const itemData = buildItemData(req.body);
        const response = await axios.post(`${ML_API}/items/validate`, itemData, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            validateStatus: () => true
        });
        const data = response.data;
        if (response.status === 401 || response.status === 403) {
            res.status(response.status).json({ error: data?.message || 'No autorizado', status: response.status, causes: [] });
            return;
        }
        const causes: ErrorCause[] = Array.isArray(data?.cause)
            ? data.cause.map((c: any) => ({ code: String(c?.code ?? ''), message: String(c?.message ?? ''), type: c?.type }))
            : [];
        let errors = causes.filter(c => c.type !== 'warning');
        if (response.status >= 400 && causes.length === 0) {
            errors = [{ code: String(data?.error ?? 'validation_error'), message: String(data?.message ?? 'ML rechazó el payload'), type: 'error' }];
        }
        res.json({
            valid: errors.length === 0,
            status: response.status,
            errors,
            warnings: causes.filter(c => c.type === 'warning')
        });
    } catch (error: any) {
        const { status, body } = mlErrorResponse(error, 'No se pudo validar la publicación');
        console.error('Error validating item:', body.error);
        res.status(status).json(body);
    }
});

/**
 * GET /api/items/listing-prices?price=&category_id=
 * Comisión por tipo de publicación (proxy de /sites/MLM/listing_prices).
 */
router.get('/listing-prices', async (req: Request, res: Response) => {
    const price = parseFloat(String(req.query['price'] ?? ''));
    const categoryId = String(req.query['category_id'] ?? '');
    if (!(price > 0) || !CATEGORY_ID_RE.test(categoryId)) {
        res.status(400).json({ error: 'price y category_id (MLM...) son obligatorios', status: 400, causes: [] });
        return;
    }
    try {
        const token = await mlAuth.getToken();
        const response = await axios.get(`${ML_API}/sites/MLM/listing_prices`, {
            headers: { Authorization: `Bearer ${token}` },
            params: { price, category_id: categoryId }
        });
        const list = (Array.isArray(response.data) ? response.data : [])
            .filter((p: any) => p.listing_type_id === 'gold_special' || p.listing_type_id === 'gold_pro')
            .map((p: any) => ({
                listing_type_id: p.listing_type_id,
                listing_type_name: p.listing_type_id === 'gold_pro' ? 'Premium' : 'Clásica',
                sale_fee_amount: p.sale_fee_amount,
                percentage_fee: p.sale_fee_details?.percentage_fee ?? null,
                fixed_fee: p.sale_fee_details?.fixed_fee ?? 0
            }));
        res.json(list);
    } catch (error: any) {
        const { status, body } = mlErrorResponse(error, 'No se pudieron obtener las comisiones');
        res.status(status).json(body);
    }
});

/**
 * POST /api/items
 * Create a new product listing on MercadoLibre.
 * Devuelve { success, item, description: { ok, error? } }. Si el item se creó pero la descripción
 * falló, responde 201 con description.ok = false (el cliente NO debe reintentar la creación).
 */
router.post('/', async (req: Request, res: Response) => {
    const basic = validateBasicFields(req.body);
    if (basic) {
        res.status(400).json({ error: basic, status: 400, causes: [{ code: 'missing_fields', message: basic }] });
        return;
    }

    let token: string;
    let response: any;
    try {
        token = await mlAuth.getToken();
        const itemData = buildItemData(req.body);
        console.log('Creating item:', itemData.family_name || itemData.title);
        response = await axios.post(`${ML_API}/items`, itemData, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        });
    } catch (error: any) {
        const { status, body } = mlErrorResponse(error, 'No se pudo crear la publicación');
        console.error('Error creating item:', status, body.error, body.causes.map((c: ErrorCause) => c.code).join(','));
        res.status(status).json(body);
        return;
    }

    const itemId = response.data.id;
    console.log('Item created:', itemId);

    // El item ya existe: todo lo que falle desde aquí NO debe provocar un reintento del POST.
    clearItemsCache();

    const description = (req.body.description || '').toString();
    let descriptionResult: { ok: boolean; error?: string } = { ok: true };
    if (description.trim()) {
        try {
            await postDescription(token, itemId, description);
        } catch (descError: any) {
            const { body } = mlErrorResponse(descError, 'No se pudo guardar la descripción');
            console.error('Error adding description to', itemId, body.error);
            descriptionResult = { ok: false, error: body.causes[0]?.message || body.error };
        }
    }

    res.status(201).json({
        success: true,
        item: response.data,
        description: descriptionResult,
        message: 'Product published successfully',
    });
});

/**
 * POST /api/items/:id/description
 * Reintento del paso "descripción" de un item ya creado (POST, o PUT si ya existía).
 */
router.post('/:id/description', async (req: Request, res: Response) => {
    const id = req.params['id'];
    if (!ITEM_ID_RE.test(id)) {
        res.status(400).json({ error: 'ID de publicación inválido', status: 400, causes: [] });
        return;
    }
    const text = (req.body?.plain_text || req.body?.description || '').toString();
    if (!text.trim()) {
        res.status(400).json({ error: 'La descripción está vacía', status: 400, causes: [] });
        return;
    }
    try {
        const token = await mlAuth.getToken();
        await postDescription(token, id, text);
        res.json({ success: true });
    } catch (error: any) {
        const { status, body } = mlErrorResponse(error, 'No se pudo guardar la descripción');
        res.status(status).json(body);
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

        if (ids.some(i => !ITEM_ID_RE.test(i))) {
            return res.status(400).json({ error: 'Invalid item ID in ids' });
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
                    `https://api.mercadolibre.com/visits/items?ids=${encodeURIComponent(itemId)}`,
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
        console.error('❌ Error fetching visit counts:', safeError(error));
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
        if (!ITEM_ID_RE.test(id)) {
            res.status(400).json({ error: 'ID de publicación inválido', status: 400, causes: [] });
            return;
        }
        const token = await mlAuth.getToken();

        const response = await axios.get(
            `https://api.mercadolibre.com/items/${encodeURIComponent(id)}/description`,
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
        if (!ITEM_ID_RE.test(id)) {
            return res.status(400).json({ error: 'ID de publicación inválido' });
        }
        const { price, quantity, listing_type_id } = req.body;

        if (!price || !quantity || !listing_type_id) {
            return res.status(400).json({
                error: 'Missing required fields: price, quantity, listing_type_id'
            });
        }

        const token = await mlAuth.getToken();

        console.log(`🔄 Relisting item ${id} with price: ${price}, quantity: ${quantity}`);

        const response = await axios.post(
            `https://api.mercadolibre.com/items/${encodeURIComponent(id)}/relist`,
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

// ============================================
// EDITAR (precio, stock, descripción)
// ============================================

interface EditLocks { price?: string; stock?: string; description?: string; }

function authHeaders(token: string) {
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function fetchDescriptionText(token: string, id: string): Promise<string> {
    try {
        const r = await axios.get(`${ML_API}/items/${id}/description`, { headers: authHeaders(token) });
        return String(r.data?.plain_text ?? r.data?.text ?? '');
    } catch (e: any) {
        if (e?.response?.status === 404) return '';
        throw e;
    }
}

function variationLabel(v: any): string {
    const parts = (v?.attribute_combinations || []).map((a: any) => a?.value_name).filter(Boolean);
    return parts.length ? parts.join(' / ') : `Variante ${v?.id}`;
}

function computeLocks(item: any): { locks: EditLocks; notes: string[] } {
    const locks: EditLocks = {};
    const notes: string[] = [];
    if (['closed', 'under_review', 'inactive'].includes(item.status)) {
        const why = item.status === 'closed'
            ? 'Finalizada: usa Republicar.'
            : item.status === 'under_review' ? 'En revisión: no se puede editar.' : 'Inactiva: no se puede editar.';
        return { locks: { price: why, stock: why, description: why }, notes };
    }
    if (item.shipping?.logistic_type === 'fulfillment') {
        locks.stock = 'Stock administrado por Full: se gestiona desde Mercado Libre.';
    }
    if (Array.isArray(item.deal_ids) && item.deal_ids.length > 0) {
        locks.price = 'La publicación participa en una promoción o campaña; el precio se gestiona allí.';
    }
    if (item.catalog_listing) {
        notes.push('Publicación de catálogo: el precio puede estar sujeto a competir por la Buy Box.');
    }
    return { locks, notes };
}

/**
 * GET /api/items/:id/editable
 * Datos frescos de ML para el panel "Editar", con bloqueos por campo.
 */
router.get('/:id/editable', async (req: Request, res: Response) => {
    const id = req.params['id'];
    if (!ITEM_ID_RE.test(id)) {
        res.status(400).json({ error: 'ID de publicación inválido', status: 400, causes: [] });
        return;
    }
    try {
        const token = await mlAuth.getToken();
        const [itemRes, description] = await Promise.all([
            axios.get(`${ML_API}/items/${id}`, { headers: authHeaders(token) }),
            fetchDescriptionText(token, id)
        ]);
        const item = itemRes.data;
        const { locks, notes } = computeLocks(item);
        res.json({
            id: item.id,
            title: item.title,
            status: item.status,
            listing_type_id: item.listing_type_id,
            price: item.price,
            available_quantity: item.available_quantity,
            variations: (item.variations || []).map((v: any) => ({
                id: v.id,
                label: variationLabel(v),
                available_quantity: v.available_quantity,
                price: v.price
            })),
            description,
            locks,
            notes
        });
    } catch (error: any) {
        const { status, body } = mlErrorResponse(error, 'No se pudo cargar la publicación');
        res.status(status).json(body);
    }
});

/** Stock para items de User Products: ML pide el endpoint de stock por user_product_id. */
async function putUserProductStock(token: string, item: any, quantity: number): Promise<void> {
    const url = `${ML_API}/user-products/${item.user_product_id}/stock`;
    const cur = await axios.get(url, { headers: authHeaders(token) });
    const version = cur.headers['x-version'];
    await axios.put(`${url}/type/seller_warehouse`, { quantity }, {
        headers: { ...authHeaders(token), ...(version ? { 'If-Match': String(version) } : {}) }
    });
}

/**
 * PUT /api/items/:id
 * Body: { price?, available_quantity?, variations?: [{id, available_quantity?, price?}], description? }
 * Solo envía a ML lo que cambió. Si falla el item no toca la descripción; si falla la
 * descripción responde 207 con el resultado parcial.
 */
router.put('/:id', async (req: Request, res: Response) => {
    const id = req.params['id'];
    if (!ITEM_ID_RE.test(id)) {
        res.status(400).json({ error: 'ID de publicación inválido', status: 400, causes: [] });
        return;
    }
    const body = req.body || {};
    const bad = (message: string, code = 'invalid_field') =>
        res.status(400).json({ error: message, status: 400, causes: [{ code, message }] });
    const okPrice = (p: any) => typeof p === 'number' && Number.isFinite(p) && p >= 0.01 && p <= 99999999;
    const okQty = (q: any) => Number.isInteger(q) && q >= 0 && q <= 99999;

    const hasPrice = body.price !== undefined && body.price !== null;
    const hasStock = body.available_quantity !== undefined && body.available_quantity !== null;
    const hasVars = Array.isArray(body.variations) && body.variations.length > 0;
    const hasDesc = typeof body.description === 'string';

    if (hasPrice && !okPrice(body.price)) {
        return void bad('El precio debe ser un número entre 0.01 y 99,999,999', 'invalid_price');
    }
    if (hasStock && !okQty(body.available_quantity)) {
        return void bad('El stock debe ser un entero entre 0 y 99,999', 'invalid_stock');
    }
    if (hasVars) {
        for (const v of body.variations) {
            if (!v || !/^\d+$/.test(String(v.id))) return void bad('Id de variante inválido', 'invalid_variation');
            if (v.available_quantity !== undefined && !okQty(v.available_quantity)) {
                return void bad('El stock de la variante debe ser un entero entre 0 y 99,999', 'invalid_stock');
            }
            if (v.price !== undefined && !okPrice(v.price)) {
                return void bad('El precio de la variante debe ser un número entre 0.01 y 99,999,999', 'invalid_price');
            }
        }
    }
    if (hasDesc && body.description.length > 50000) {
        return void bad('La descripción es demasiado larga', 'invalid_description');
    }
    if (!hasPrice && !hasStock && !hasVars && !hasDesc) {
        return void bad('No hay cambios para guardar', 'no_changes');
    }

    try {
        const token = await mlAuth.getToken();
        const current = (await axios.get(`${ML_API}/items/${id}`, { headers: authHeaders(token) })).data;
        const { locks } = computeLocks(current);
        if ((hasPrice && locks.price) || ((hasStock || hasVars) && locks.stock) || (hasDesc && locks.description)) {
            const msg = (hasPrice && locks.price) || ((hasStock || hasVars) && locks.stock) || locks.description || 'Campo bloqueado';
            return void res.status(409).json({ error: msg, status: 409, causes: [{ code: 'field_locked', message: msg }] });
        }

        const itemVars: any[] = current.variations || [];
        const hasItemVars = itemVars.length > 0;
        if (hasVars) {
            const known = new Set(itemVars.map(v => String(v.id)));
            if (!hasItemVars || body.variations.some((v: any) => !known.has(String(v.id)))) {
                return void bad('Alguna variante no pertenece a la publicación', 'invalid_variation');
            }
        }
        if (hasItemVars && hasStock) {
            return void bad('Esta publicación tiene variantes: edita el stock por variante', 'invalid_stock');
        }

        // Solo cambios reales
        const payload: any = {};
        if (hasPrice && body.price !== current.price) payload.price = body.price;
        if (hasStock && body.available_quantity !== current.available_quantity) {
            payload.available_quantity = body.available_quantity;
        }
        if (hasVars) {
            const changed = body.variations
                .map((v: any) => {
                    const cur = itemVars.find(x => String(x.id) === String(v.id));
                    const out: any = { id: Number(v.id) };
                    if (v.available_quantity !== undefined && v.available_quantity !== cur.available_quantity) out.available_quantity = v.available_quantity;
                    if (v.price !== undefined && v.price !== cur.price) out.price = v.price;
                    return out;
                })
                .filter((v: any) => Object.keys(v).length > 1);
            if (changed.length) payload.variations = changed;
        }

        const itemResult: any = { ok: true, changed: false };
        if (Object.keys(payload).length) {
            try {
                await axios.put(`${ML_API}/items/${id}`, payload, { headers: authHeaders(token) });
                itemResult.changed = true;
            } catch (e: any) {
                // Sellers de User Products: el stock va por /user-products/{id}/stock
                const raw = JSON.stringify(e?.response?.data || '');
                if (payload.available_quantity !== undefined && current.user_product_id && /available_quantity|stock|user.?product/i.test(raw)) {
                    const qty = payload.available_quantity;
                    delete payload.available_quantity;
                    if (Object.keys(payload).length) {
                        await axios.put(`${ML_API}/items/${id}`, payload, { headers: authHeaders(token) });
                    }
                    await putUserProductStock(token, current, qty);
                    itemResult.changed = true;
                    itemResult.stock_via = 'user_product';
                } else {
                    throw e;
                }
            }
        }

        const descResult: any = { ok: true, changed: false };
        if (hasDesc) {
            const currentDesc = await fetchDescriptionText(token, id);
            if (body.description !== currentDesc) {
                try {
                    try {
                        await axios.put(`${ML_API}/items/${id}/description?api_version=2`, { plain_text: body.description }, { headers: authHeaders(token) });
                    } catch (e: any) {
                        if (e?.response?.status === 404) {
                            await axios.post(`${ML_API}/items/${id}/description`, { plain_text: body.description }, { headers: authHeaders(token) });
                        } else throw e;
                    }
                    descResult.changed = true;
                } catch (e: any) {
                    const { body: eb } = mlErrorResponse(e, 'No se pudo guardar la descripción');
                    clearItemsCache();
                    return void res.status(207).json({
                        item: itemResult,
                        description: { ok: false, error: eb.error, causes: eb.causes }
                    });
                }
            }
        }

        clearItemsCache();
        const fresh = (await axios.get(`${ML_API}/items/${id}`, { headers: authHeaders(token) })).data;
        res.json({
            item: itemResult,
            description: descResult,
            updated: {
                id: fresh.id,
                price: fresh.price,
                available_quantity: fresh.available_quantity,
                status: fresh.status,
                last_updated: fresh.last_updated
            }
        });
    } catch (error: any) {
        const { status, body: eb } = mlErrorResponse(error, 'No se pudo guardar la publicación');
        res.status(status).json(eb);
    }
});

/**
 * GET /api/items/:id
 * Item fresco desde ML (para duplicar sin depender del estado viejo de la lista).
 */
router.get('/:id', async (req: Request, res: Response) => {
    const id = req.params['id'];
    if (!ITEM_ID_RE.test(id)) {
        res.status(400).json({ error: 'ID de publicación inválido', status: 400, causes: [] });
        return;
    }
    try {
        const token = await mlAuth.getToken();
        const response = await axios.get(`${ML_API}/items/${encodeURIComponent(id)}`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        res.json(response.data);
    } catch (error: any) {
        const { status, body } = mlErrorResponse(error, 'No se pudo obtener la publicación');
        res.status(status).json(body);
    }
});

export default router;
