import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';
import { mlAuth } from '../backend/src/auth/oauth';
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

// Connection status for the frontend (never exposes tokens)
app.get('/api/auth/status', async (req, res) => {
  res.json({ connected: await mlAuth.isConnected() });
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

// OAuth authorization endpoint
// PKCE verifier + state travel in a short-lived httpOnly cookie between /auth and /callback
const OAUTH_COOKIE = 'ml_oauth';

app.get('/api/auth', (req, res) => {
  const { state, verifier, challenge } = mlAuth.createPkce();
  res.cookie(OAUTH_COOKIE, JSON.stringify({ state, verifier }), {
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

  if (!code || typeof code !== 'string') {
    res.status(400).send('Authorization code not found');
    return;
  }

  const rawCookie = (req.headers.cookie || '')
    .split(';')
    .map(c => c.trim())
    .find(c => c.startsWith(`${OAUTH_COOKIE}=`));
  let saved: { state?: string; verifier?: string } = {};
  try {
    saved = rawCookie ? JSON.parse(decodeURIComponent(rawCookie.slice(OAUTH_COOKIE.length + 1))) : {};
  } catch { /* malformed cookie: treated as missing */ }
  res.clearCookie(OAUTH_COOKIE);

  if (!saved.state || saved.state !== state) {
    res.status(400).send('Invalid OAuth state. Please start again from /api/auth');
    return;
  }

  try {
    await mlAuth.getAccessToken(code, saved.verifier);
    res.send(`
      <html>
        <head>
          <style>
            body {
              font-family: Arial, sans-serif;
              display: flex;
              justify-content: center;
              align-items: center;
              height: 100vh;
              margin: 0;
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            }
            .container {
              background: white;
              padding: 40px;
              border-radius: 10px;
              box-shadow: 0 10px 40px rgba(0,0,0,0.1);
              text-align: center;
            }
            h1 { color: #333; margin-bottom: 10px; }
            p { color: #666; margin-bottom: 20px; }
            .success { color: #4CAF50; font-size: 48px; margin-bottom: 20px; }
            a {
              display: inline-block;
              background: #667eea;
              color: white;
              text-decoration: none;
              padding: 12px 24px;
              border-radius: 6px;
              margin-top: 15px;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="success">✅</div>
            <h1>¡Autorización exitosa!</h1>
            <p>Tu app ha sido autorizada correctamente.</p>
            <a href="${process.env['FRONTEND_URL'] || '/'}">Ir al Dashboard</a>
          </div>
          <script>
            // Opened as a popup from the dashboard: close it so the app reloads
            if (window.opener) window.close();
          </script>
        </body>
      </html>
    `);
  } catch (error) {
    console.error('Error in callback:', error);
    res.status(500).send(`
      <html>
        <head>
          <style>
            body {
              font-family: Arial, sans-serif;
              display: flex;
              justify-content: center;
              align-items: center;
              height: 100vh;
              margin: 0;
              background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
            }
            .container {
              background: white;
              padding: 40px;
              border-radius: 10px;
              box-shadow: 0 10px 40px rgba(0,0,0,0.1);
              text-align: center;
            }
            h1 { color: #333; margin-bottom: 10px; }
            p { color: #666; }
            .error { color: #f5576c; font-size: 48px; margin-bottom: 20px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="error">❌</div>
            <h1>Error en la autorización</h1>
            <p>Hubo un problema al autorizar la app. Por favor intenta de nuevo.</p>
          </div>
        </body>
      </html>
    `);
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
