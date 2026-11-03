import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import axios from 'axios';
import FormData from 'form-data';
import { mlAuth } from '../auth/oauth';
import { bindToCurrentAccount } from '../auth/context';

const router = Router();

// Multer en memoria. En Vercel el cuerpo máximo es 4.5 MB (la función tiene 1 GB), así que
// un límite de 4 MB por archivo, 1 archivo y pocos campos acota el uso de memoria.
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: MAX_UPLOAD_BYTES,
        files: 1,
        fields: 5,
        parts: 6,
        fieldSize: 1024,
    },
    fileFilter: (req, file, cb) => {
        // Filtro rápido por MIME declarado; la validación real es por bytes (detectImageType)
        if (['image/jpeg', 'image/jpg', 'image/png', 'image/webp'].includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type. Only JPG, PNG and WEBP are allowed.'));
        }
    }
});

/** Tipo real de imagen según los primeros bytes (JPEG, PNG, WebP). SVG y demás se rechazan. */
export const detectImageType = (buf: Buffer): { mime: string; ext: string } | null => {
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
        return { mime: 'image/jpeg', ext: 'jpg' };
    }
    if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        return { mime: 'image/png', ext: 'png' };
    }
    if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
        return { mime: 'image/webp', ext: 'webp' };
    }
    return null;
};

/** Ejecuta multer y convierte sus errores (tamaño, tipo, partes) en 4xx claros en vez de 500. */
const handleUpload = (req: Request, res: Response, next: NextFunction) => {
    // multer termina desde eventos del stream de la petición: se fija la cuenta para el callback y lo que sigue
    upload.single('file')(req, res, bindToCurrentAccount((err: any) => {
        if (!err) return next();
        const tooBig = err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE';
        res.status(tooBig ? 413 : 400).json({
            error: tooBig ? 'File too large' : 'Invalid upload',
            message: tooBig ? 'Image exceeds the 4 MB limit' : 'Only JPG, PNG and WEBP images are allowed'
        });
    }));
};

/**
 * POST /api/images/upload
 * Upload an image to MercadoLibre CDN
 *
 * Uses the /pictures/items/upload endpoint which allows uploading images
 * without needing to associate them with a specific item ID first.
 */
router.post('/upload', handleUpload, async (req: Request, res: Response) => {
    try {
        const file = (req as any).file;
        if (!file) {
            res.status(400).json({
                error: 'No file uploaded',
                message: 'Please provide an image file'
            });
            return;
        }

        // El MIME lo declara el cliente: se valida el contenido real por magic bytes
        const detected = detectImageType(file.buffer);
        if (!detected) {
            res.status(400).json({
                error: 'Invalid file type',
                message: 'The file content is not a JPG, PNG or WEBP image'
            });
            return;
        }

        // Get valid access token
        const token = await mlAuth.getToken();

        console.log('📸 Uploading image to ML CDN...');
        console.log('  - File size:', (file.size / 1024).toFixed(2), 'KB');
        console.log('  - Detected type:', detected.mime);

        // Create form data with the image file
        const formData = new FormData();
        formData.append('file', file.buffer, {
            filename: `image.${detected.ext}`, // nombre fijo: no se reenvía el del cliente
            contentType: detected.mime
        });

        // Upload to MercadoLibre CDN using the pictures/items/upload endpoint
        // This endpoint doesn't require an item ID
        const uploadResponse = await axios.post(
            'https://api.mercadolibre.com/pictures/items/upload',
            formData,
            {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    ...formData.getHeaders()
                },
                maxContentLength: 20 * 1024 * 1024,
                maxBodyLength: 20 * 1024 * 1024
            }
        );

        console.log('✅ Image uploaded successfully!');
        console.log('  - Image ID:', uploadResponse.data.id);
        console.log('  - Variations:', uploadResponse.data.variations?.length || 0);

        // Return the full response from ML
        res.json(uploadResponse.data);

    } catch (error: any) {
        console.error('❌ Error uploading image:', error.response?.data || error.message);

        if (error.response?.status === 401) {
            res.status(401).json({
                error: 'Unauthorized',
                message: 'Access token is invalid or expired. Please re-authorize the app.'
            });
            return;
        }

        if (error.response?.status === 400) {
            res.status(400).json({
                error: 'Invalid image',
                message: 'The image does not meet MercadoLibre requirements (JPG/PNG, 500x500 to 1920x1920, max 10MB)'
            });
            return;
        }

        res.status(error.response?.status || 500).json({
            error: 'Failed to upload image',
            message: error.response?.data?.message || error.message
        });
    }
});

/**
 * POST /api/images/diagnostic
 * Validate an image using MercadoLibre's diagnostic API
 *
 * Validates images for moderation issues like:
 * - Watermarks
 * - Text overlays
 * - Background issues
 * - Quality problems
 */
router.post('/diagnostic', async (req: Request, res: Response) => {
    try {
        const { picture_url, context } = req.body;

        if (!picture_url) {
            res.status(400).json({
                error: 'Missing image data',
                message: 'Please provide picture_url (URL, Base64, or picture_id)'
            });
            return;
        }

        if (!context?.category_id) {
            res.status(400).json({
                error: 'Missing category_id',
                message: 'Please provide context.category_id'
            });
            return;
        }

        const token = await mlAuth.getToken();

        console.log('🔍 Validating image with ML diagnostic API...');
        console.log('  - Category:', context.category_id);
        console.log('  - Picture type:', context.picture_type || 'thumbnail');
        console.log('  - Title:', context.title || '(not provided)');
        console.log('  - Picture URL/ID length:', picture_url.length);

        // Call MercadoLibre diagnostic API
        const diagnosticResponse = await axios.post(
            'https://api.mercadolibre.com/moderations/pictures/diagnostic',
            {
                picture_url: picture_url, // Can be URL, Base64, or picture_id
                context: {
                    category_id: context.category_id,
                    picture_type: context.picture_type || 'thumbnail',
                    ...(context.title && { title: context.title }) // Include title if provided
                }
            },
            {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        console.log('✅ Diagnostic completed');
        console.log('  - Action:', diagnosticResponse.data.action);
        console.log('  - Detections:', diagnosticResponse.data.detections?.length || 0);

        res.json(diagnosticResponse.data);

    } catch (error: any) {
        console.error('❌ Error in diagnostic:', error.response?.data || error.message);

        if (error.response?.status === 401) {
            res.status(401).json({
                error: 'Unauthorized',
                message: 'Access token is invalid or expired. Please re-authorize the app.'
            });
            return;
        }

        if (error.response?.status === 400) {
            res.status(400).json({
                error: 'Invalid request',
                message: 'The diagnostic request is invalid'
            });
            return;
        }

        res.status(error.response?.status || 500).json({
            error: 'Failed to validate image',
            message: error.response?.data?.message || error.message
        });
    }
});

/**
 * GET /api/images/catalog
 * Get all images from all user's publications
 *
 * This endpoint:
 * 1. Fetches all user's items
 * 2. Extracts all images from each item
 * 3. Deduplicates by URL
 * 4. Returns consolidated catalog with metadata
 */
router.get('/catalog', async (req: Request, res: Response) => {
    try {
        const token = await mlAuth.getToken();

        console.log('🖼️  Fetching image catalog...');

        // Step 1: Get seller ID
        const userResponse = await axios.get('https://api.mercadolibre.com/users/me', {
            headers: { Authorization: `Bearer ${token}` }
        });
        const sellerId = userResponse.data.id;

        console.log('  - Seller ID:', sellerId);

        // Step 2: Fetch ALL items in batches
        const batchSize = 100; // ML API max limit
        let currentOffset = 0;
        let allItemIds: string[] = [];
        let totalItems = 0;

        // First request to get total count
        const firstBatch = await axios.get(
            `https://api.mercadolibre.com/users/${sellerId}/items/search`,
            {
                headers: { Authorization: `Bearer ${token}` },
                params: { offset: 0, limit: batchSize }
            }
        );

        totalItems = firstBatch.data.paging.total;
        allItemIds.push(...firstBatch.data.results);
        currentOffset += batchSize;

        console.log(`  - Total items: ${totalItems}`);
        console.log(`  - Fetched batch 1: ${firstBatch.data.results.length} items`);

        // Fetch remaining batches
        while (allItemIds.length < totalItems) {
            const batchResponse = await axios.get(
                `https://api.mercadolibre.com/users/${sellerId}/items/search`,
                {
                    headers: { Authorization: `Bearer ${token}` },
                    params: { offset: currentOffset, limit: batchSize }
                }
            );

            const batchIds = batchResponse.data.results;
            allItemIds.push(...batchIds);

            console.log(`  - Fetched batch ${Math.floor(currentOffset / batchSize) + 1}: ${batchIds.length} items (${allItemIds.length}/${totalItems})`);

            if (batchIds.length < batchSize) {
                break; // No more items
            }

            currentOffset += batchSize;
        }

        console.log(`  ✅ Fetched all ${allItemIds.length} item IDs`);

        // Step 3: Fetch item details in batches of 20 (ML API limit for /items?ids=)
        const detailBatchSize = 20;
        const allItemsData: any[] = [];

        for (let i = 0; i < allItemIds.length; i += detailBatchSize) {
            const batchIds = allItemIds.slice(i, i + detailBatchSize);

            const detailsResponse = await axios.get(
                `https://api.mercadolibre.com/items?ids=${batchIds.join(',')}`,
                { headers: { Authorization: `Bearer ${token}` } }
            );

            const successfulItems = detailsResponse.data
                .filter((item: any) => item.code === 200)
                .map((item: any) => item.body);

            allItemsData.push(...successfulItems);

            console.log(`  - Fetched details batch ${Math.floor(i / detailBatchSize) + 1}: ${successfulItems.length} items (${allItemsData.length}/${allItemIds.length})`);
        }

        console.log(`  ✅ Fetched details for ${allItemsData.length} items`);

        // Step 4: Extract all images with metadata
        interface CatalogImage {
            picture_id: string;
            full_url: string;
            thumbnail_url: string;
            variations: any[];
            source_item: {
                id: string;
                title: string;
                status: string;
            };
            date_created: string;
        }

        const imageMap = new Map<string, CatalogImage>(); // Use Map to deduplicate by URL

        for (const item of allItemsData) {
            if (item.pictures && Array.isArray(item.pictures)) {
                for (const picture of item.pictures) {
                    // Helper to extract numeric size from size string (e.g., "2048x2048" -> 2048)
                    const extractSize = (sizeStr: string): number => {
                        const match = sizeStr.match(/(\d+)x(\d+)/);
                        return match ? Math.max(parseInt(match[1]), parseInt(match[2])) : 0;
                    };

                    // Find HIGHEST quality variation (largest size)
                    let highestQualityVariation = picture.variations?.[0];
                    let maxSize = 0;

                    if (picture.variations && Array.isArray(picture.variations)) {
                        for (const variation of picture.variations) {
                            const size = extractSize(variation.size);
                            if (size > maxSize) {
                                maxSize = size;
                                highestQualityVariation = variation;
                            }
                        }
                    }

                    // Use highest quality URL as full_url
                    const fullUrl = highestQualityVariation?.secure_url ||
                                   highestQualityVariation?.url ||
                                   picture.secure_url ||
                                   picture.url;

                    // Skip if already added (deduplicate)
                    if (imageMap.has(fullUrl)) {
                        continue;
                    }

                    // Find thumbnail variation (smallest size for preview)
                    const thumbnailVariation = picture.variations?.find((v: any) =>
                        v.size === '500x500' || v.size === '250x250'
                    ) || picture.variations?.[0];

                    const catalogImage: CatalogImage = {
                        picture_id: picture.id,
                        full_url: fullUrl,
                        thumbnail_url: thumbnailVariation?.secure_url || thumbnailVariation?.url || fullUrl,
                        variations: picture.variations || [],
                        source_item: {
                            id: item.id,
                            title: item.title,
                            status: item.status
                        },
                        date_created: item.date_created
                    };

                    imageMap.set(fullUrl, catalogImage);
                }
            }
        }

        const images = Array.from(imageMap.values());

        console.log(`  ✅ Extracted ${images.length} unique images from ${allItemsData.length} items`);

        // Step 5: Return catalog
        res.json({
            images,
            total: images.length,
            unique_images: images.length,
            total_items: allItemsData.length
        });

    } catch (error: any) {
        console.error('❌ Error fetching image catalog:', error.response?.data || error.message);

        if (error.response?.status === 401) {
            res.status(401).json({
                error: 'Unauthorized',
                message: 'Access token is invalid or expired. Please re-authorize the app.'
            });
            return;
        }

        res.status(500).json({
            error: 'Failed to fetch image catalog',
            message: error.response?.data?.message || error.message
        });
    }
});

export default router;
