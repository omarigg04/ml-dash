import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';
import { safeError, safeReturnPath } from '../backend/src/security';
import { mlAuth, UserNotAllowedError, TokenStorageError, checkTokenStorage } from '../backend/src/auth/oauth';
import { createSession, getSession, clearSession, getCookie } from '../backend/src/auth/session';
import ordersRouter from '../backend/src/routes/orders';
import shipmentsRouter from '../backend/src/routes/shipments';
import itemsRouter from '../backend/src/routes/items';
import imagesRouter from '../backend/src/routes/images';
import categoriesRouter from '../backend/src/routes/categories';
import summaryRouter from '../backend/src/routes/summary';
import analyticsRouter from '../backend/src/routes/analytics';

// Load environment variables
dotenv.config();

const app = express();

// Entorno: producción (Vercel / NODE_ENV=production) vs desarrollo local
const isProduction = !!process.env['VERCEL'] || process.env['NODE_ENV'] === 'production';
const wantsNoAuth = process.env['LOCAL_DEV_NO_AUTH'] === 'true';
if (wantsNoAuth && isProduction) {
  console.warn('[security] LOCAL_DEV_NO_AUTH is ignored in production: authentication is enforced');
}
// Bypass de autenticación solo con opt-in explícito y nunca en producción
const noAuth = wantsNoAuth && !isProduction;
if (noAuth) {
  console.warn('[security] LOCAL_DEV_NO_AUTH=true: authentication is DISABLED (local development only)');
}

// CORS con lista blanca: FRONTEND_URL (separada por comas) + orígenes de dev local.
// En producción el frontend comparte origen con la API, así que no necesita CORS.
const allowedOrigins = new Set<string>(
  (process.env['FRONTEND_URL'] || '')
    .split(',')
    .map(o => o.trim().replace(/\/+$/, ''))
    .filter(Boolean)
);
if (!isProduction) {
  allowedOrigins.add('http://127.0.0.1:4200');
  allowedOrigins.add('http://localhost:4200');
}

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  res.setHeader('Cache-Control', 'no-store');
  if (isProduction) {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
});
app.use(cors({
  // Sin cabecera Origin (mismo origen, curl, servidor) se permite; con Origin solo la lista blanca
  origin: (origin, callback) => callback(null, !origin || allowedOrigins.has(origin)),
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));

// Session auth for /api/*. Skipped only with LOCAL_DEV_NO_AUTH=true outside production
const PUBLIC_PATHS = [
  '/api',
  '/api/auth',
  '/api/callback',
  '/api/auth/status',
  '/api/auth/logout',
];
app.use((req, res, next) => {
  if (noAuth || PUBLIC_PATHS.includes(req.path) || getSession(req)) {
    return next();
  }
  res.status(401).json({ error: 'Unauthorized', code: 'SESSION_REQUIRED', message: 'Please log in with MercadoLibre' });
});

// Health check endpoint
app.get('/api', (req, res) => {
  res.json({
    status: 'running',
    message: 'MercadoLibre Dashboard API',
    hasToken: mlAuth.hasValidToken(),
  });
});

// Session + store connection status for the frontend (never exposes tokens)
app.get('/api/auth/status', async (req, res) => {
  const session = getSession(req);
  res.json({
    authenticated: noAuth || !!session,
    userId: session?.uid ?? null,
    connected: await mlAuth.isConnected(),
    storage: await checkTokenStorage(),
  });
});

app.post('/api/auth/logout', (req, res) => {
  clearSession(res);
  res.json({ success: true });
});

// Check user/seller status
app.get('/api/user/status', async (req, res) => {
  try {
    const token = await mlAuth.getToken();
    // Get user info
    const userResponse = await axios.get('https://api.mercadolibre.com/users/me', {
      headers: { Authorization: `Bearer ${token}` }
    });

    const userId = userResponse.data.id;

    // Get listing limits
    const limitsResponse = await axios.get(`https://api.mercadolibre.com/users/${userId}/listings_limit`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    res.json({
      user: {
        id: userResponse.data.id,
        nickname: userResponse.data.nickname,
        email: userResponse.data.email,
        sellerReputation: userResponse.data.seller_reputation,
        status: userResponse.data.status,
      },
      listingLimits: limitsResponse.data,
      canPublish: userResponse.data.status?.site_status === 'active'
    });
  } catch (error: any) {
    res.status(500).json({
      error: 'Failed to get user status',
      details: error.response?.data || error.message
    });
  }


});

// OAuth login: ML authorization doubles as the dashboard login.
// PKCE verifier, state and returnUrl travel in a short-lived httpOnly cookie
const OAUTH_COOKIE = 'ml_oauth';
// FRONTEND_URL puede ser una lista separada por comas: se redirige al primero
const frontendUrl = (path: string) => `${(process.env['FRONTEND_URL'] || '').split(',')[0].trim().replace(/\/+$/, '')}${path}`;

app.get('/api/auth', (req, res) => {
  const returnUrl = safeReturnPath(req.query['returnUrl']);

  const { state, verifier, challenge } = mlAuth.createPkce();
  res.cookie(OAUTH_COOKIE, JSON.stringify({ state, verifier, returnUrl }), {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    maxAge: 10 * 60 * 1000,
  });
  res.redirect(mlAuth.getAuthorizationUrl(state, challenge));
});

// OAuth callback endpoint
app.get('/api/callback', async (req, res) => {
  const { code, state } = req.query;

  let saved: { state?: string; verifier?: string; returnUrl?: string } = {};
  try {
    saved = JSON.parse(getCookie(req, OAUTH_COOKIE) || '{}');
  } catch { /* malformed cookie: treated as missing */ }
  res.clearCookie(OAUTH_COOKIE);

  if (!code || typeof code !== 'string') {
    res.redirect(frontendUrl('/login?error=no_code'));
    return;
  }

  if (!saved.state || saved.state !== state) {
    res.redirect(frontendUrl('/login?error=invalid_state'));
    return;
  }

  try {
    const tokenData = await mlAuth.getAccessToken(code, saved.verifier);
    createSession(res, tokenData.user_id);
    res.redirect(frontendUrl(safeReturnPath(saved.returnUrl)));
  } catch (error) {
    console.error('Error in callback:', safeError(error));
    if (error instanceof UserNotAllowedError) {
      res.redirect(frontendUrl(`/login?error=not_allowed&uid=${error.userId}`));
      return;
    }
    if (error instanceof TokenStorageError) {
      res.redirect(frontendUrl('/login?error=storage_failed'));
      return;
    }
    res.redirect(frontendUrl('/login?error=auth_failed'));
  }
});

// API Routes
console.log('📦 Registering API routes...');
app.use('/api/orders', ordersRouter);
app.use('/api/shipments', shipmentsRouter);
app.use('/api/items', itemsRouter);
app.use('/api/images', imagesRouter);
app.use('/api/categories', categoriesRouter);
app.use('/api/summary', summaryRouter);
app.use('/api/analytics', analyticsRouter);
console.log('✅ All routes registered (including /api/categories)');

// Error handling middleware
app.use((err: any, req: any, res: any, next: any) => {
  console.error('Unhandled error:', safeError(err));
  const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 500 ? err.status : 500;
  res.status(status).json({
    error: status === 500 ? 'Internal server error' : 'Bad request',
  });
});

// Start server for local development only (not in Vercel)
if (!process.env['VERCEL']) {
  const PORT = Number(process.env['PORT'] || 3000);
  // Loopback only: the local backend holds the owner's ML token
  const HOST = '127.0.0.1';

  app.listen(PORT, HOST, () => {
    console.log(`🚀 MercadoLibre Dashboard Backend (Local) on http://${HOST}:${PORT}`);
  });
}

// Export for Vercel serverless
export default app;
