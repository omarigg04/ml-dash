import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';
import { mlAuth, UserNotAllowedError } from '../backend/src/auth/oauth';
import { createSession, getSession, clearSession, getCookie } from '../backend/src/auth/session';
import ordersRouter from '../backend/src/routes/orders';
import shipmentsRouter from '../backend/src/routes/shipments';
import itemsRouter from '../backend/src/routes/items';
import imagesRouter from '../backend/src/routes/images';
import categoriesRouter from '../backend/src/routes/categories';

// Load environment variables
dotenv.config();

const app = express();

// Middleware
app.use(cors({
  origin: '*', // Allow all origins in production
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session auth for /api/*. Skipped locally (OAuth needs a public HTTPS
// callback, so local dev can't obtain a session cookie)
const PUBLIC_PATHS = [
  '/api',
  '/api/auth',
  '/api/callback',
  '/api/auth/status',
  '/api/auth/logout',
  '/api/debug/token',        // protected by requireAdmin
  '/api/auth/inject-token',  // protected by requireAdmin
];
app.use((req, res, next) => {
  if (!process.env['VERCEL'] || PUBLIC_PATHS.includes(req.path) || getSession(req)) {
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

// Token-handling admin endpoints: always allowed locally, require
// the x-admin-secret header (ADMIN_SECRET env var) on Vercel
const requireAdmin = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (!process.env['VERCEL']) return next();
  const secret = process.env['ADMIN_SECRET'];
  if (secret && req.header('x-admin-secret') === secret) return next();
  res.status(403).json({ error: 'Forbidden' });
};

// Session + store connection status for the frontend (never exposes tokens)
app.get('/api/auth/status', async (req, res) => {
  const session = getSession(req);
  res.json({
    authenticated: !process.env['VERCEL'] || !!session,
    userId: session?.uid ?? null,
    connected: await mlAuth.isConnected(),
  });
});

app.post('/api/auth/logout', (req, res) => {
  clearSession(res);
  res.json({ success: true });
});

// Debug endpoint to get current token
app.get('/api/debug/token', requireAdmin, async (req, res) => {
  try {
    await (mlAuth as any).loadTokensAsync?.() || Promise.resolve();
    const tokenData = (mlAuth as any).tokenData;

    if (!tokenData) {
      return res.json({
        hasToken: false,
        message: 'No token found. Please authorize at /api/auth'
      });
    }

    const scopesArray = tokenData.scope?.split(' ') || [];

    res.json({
      hasToken: true,
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      tokenLength: tokenData.access_token?.length || 0,
      scopes: tokenData.scope || 'No scopes found',
      scopesArray: scopesArray,
      hasOfflineAccess: scopesArray.includes('offline_access'),
      hasReadScope: scopesArray.includes('read'),
      hasWriteScope: scopesArray.includes('write'),
      tokenCreatedAt: tokenData.created_at ? new Date(tokenData.created_at).toISOString() : 'unknown',
      isExpired: mlAuth.isTokenExpired(),
      expiresIn: tokenData.expires_in
    });
  } catch (error: any) {
    res.status(500).json({
      error: 'Failed to get token info',
      message: error.message
    });
  }
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
const frontendUrl = (path: string) => `${process.env['FRONTEND_URL'] || ''}${path}`;

app.get('/api/auth', (req, res) => {
  const requested = typeof req.query['returnUrl'] === 'string' ? req.query['returnUrl'] : '/';
  // Only same-site relative paths, to avoid open redirects
  const returnUrl = requested.startsWith('/') && !requested.startsWith('//') ? requested : '/';

  const { state, verifier, challenge } = mlAuth.createPkce();
  res.cookie(OAUTH_COOKIE, JSON.stringify({ state, verifier, returnUrl }), {
    httpOnly: true,
    secure: !!process.env['VERCEL'],
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
    res.redirect(frontendUrl(saved.returnUrl || '/'));
  } catch (error) {
    console.error('Error in callback:', error);
    if (error instanceof UserNotAllowedError) {
      res.redirect(frontendUrl(`/login?error=not_allowed&uid=${error.userId}`));
      return;
    }
    res.redirect(frontendUrl('/login?error=auth_failed'));
  }
});

// Inject token endpoint (for local development testing)
app.post('/api/auth/inject-token', requireAdmin, async (req, res) => {
  try {
    const { access_token, refresh_token, expires_in, scope } = req.body;

    if (!access_token || !refresh_token) {
      return res.status(400).json({
        error: 'Missing required fields',
        message: 'Both access_token and refresh_token are required'
      });
    }

    await mlAuth.injectToken(access_token, refresh_token, expires_in, scope);

    res.json({
      success: true,
      message: 'Token injected successfully! Your backend is now authenticated.',
      scope: scope || 'offline_access read write'
    });
  } catch (error: any) {
    console.error('Error injecting token:', error);
    res.status(500).json({
      error: 'Failed to inject token',
      message: error.message
    });
  }
});

// API Routes
console.log('📦 Registering API routes...');
app.use('/api/orders', ordersRouter);
app.use('/api/shipments', shipmentsRouter);
app.use('/api/items', itemsRouter);
app.use('/api/images', imagesRouter);
app.use('/api/categories', categoriesRouter);
console.log('✅ All routes registered (including /api/categories)');

// Error handling middleware
app.use((err: any, req: any, res: any, next: any) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: err.message,
  });
});

// Start server for local development only (not in Vercel)
if (!process.env['VERCEL']) {
  const PORT = process.env['PORT'] || 3000;
  app.listen(PORT, () => {
    console.log('\n🚀 MercadoLibre Dashboard Backend (Local)');
    console.log(`📡 Server running on http://localhost:${PORT}`);
    console.log(`🔐 CORS enabled for all origins\n`);
  });
}

// Export for Vercel serverless
export default app;
