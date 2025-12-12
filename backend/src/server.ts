import 'dotenv/config';
import express, { Request, Response } from 'express';
import cors from 'cors';
import cron from 'node-cron';
import axios from 'axios';
import { mlAuth } from './auth/oauth';
import ordersRouter from './routes/orders';
import shipmentsRouter from './routes/shipments';
import itemsRouter from './routes/items';

// Environment variables are now loaded by the first import

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
  origin: 'http://localhost:4200', // Angular dev server
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check endpoint
app.get('/', (req: Request, res: Response) => {
  res.json({
    status: 'running',
    message: 'MercadoLibre Dashboard Backend',
    hasToken: mlAuth.hasValidToken(),
  });
});

// Debug endpoint to check current token scopes
app.get('/debug/token', async (req: Request, res: Response) => {
  try {
    // Access the private tokenData property
    await (mlAuth as any).loadTokensAsync?.() || Promise.resolve();
    const tokenData = (mlAuth as any).tokenData;

    if (!tokenData) {
      return res.json({
        hasToken: false,
        message: 'No token found. Please authorize at /auth'
      });
    }

    const scopesArray = tokenData.scope?.split(' ') || [];

    // Print to console (like when publishing)
    console.log('🔑 Token Debug Info (from /debug/token):');
    console.log('  - Token length:', tokenData.access_token?.length || 0);
    console.log('  - Full TOKEN:', tokenData.access_token);
    console.log('  - Refresh Token:', tokenData.refresh_token);
    console.log('  - Scopes granted:', tokenData.scope || 'NO SCOPES');
    console.log('  - Has write scope:', scopesArray.includes('write'));

    res.json({
      hasToken: true,
      access_token: tokenData.access_token, // NOW SHOWS THE FULL TOKEN
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

// Test endpoint - verify token works with MercadoLibre API
app.get('/debug/test-token', async (req: Request, res: Response) => {
  try {
    const token = await mlAuth.getToken();

    console.log('🔍 Testing token with ML API...');
    console.log('Token length:', token.length);
    console.log('Token (first 20 chars):', token.substring(0, 20) + '...');

    // Test with a simple GET request to /users/me
    const testResponse = await axios.get('https://api.mercadolibre.com/users/me', {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    console.log('✅ Token is valid!');
    console.log('User ID:', testResponse.data.id);
    console.log('User nickname:', testResponse.data.nickname);

    res.json({
      success: true,
      message: 'Token is valid and working',
      userId: testResponse.data.id,
      nickname: testResponse.data.nickname,
      siteId: testResponse.data.site_id,
      tokenWorks: true
    });
  } catch (error: any) {
    console.error('❌ Token test failed:', error.response?.data || error.message);
    res.status(500).json({
      success: false,
      error: error.response?.data || error.message,
      status: error.response?.status,
      tokenWorks: false
    });
  }
});

// OAuth authorization endpoint
app.get('/auth', (req: Request, res: Response) => {
  const authUrl = mlAuth.getAuthorizationUrl();
  res.redirect(authUrl);
});

// Clear token endpoint (for re-authorization)
app.post('/auth/clear', async (req: Request, res: Response) => {
  try {
    await mlAuth.clearTokens();
    res.json({
      success: true,
      message: 'Token cleared successfully. Please re-authorize by visiting /auth'
    });
  } catch (error) {
    console.error('Error clearing token:', error);
    res.status(500).json({
      error: 'Failed to clear token',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// OAuth callback endpoint
app.get('/callback', async (req: Request, res: Response) => {
  const { code } = req.query;

  if (!code || typeof code !== 'string') {
    return res.status(400).send('Authorization code not found');
  }

  try {
    const tokenData = await mlAuth.getAccessToken(code);
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
              max-width: 500px;
            }
            h1 { color: #333; margin-bottom: 10px; }
            p { color: #666; margin-bottom: 20px; }
            .scopes {
                background: #f0f0f0;
                padding: 10px;
                border-radius: 5px;
                font-family: monospace;
                margin: 20px 0;
                word-break: break-all;
            }
            .success { color: #4CAF50; font-size: 48px; margin-bottom: 20px; }
            button {
              background: #667eea;
              color: white;
              border: none;
              padding: 12px 24px;
              border-radius: 6px;
              cursor: pointer;
              font-size: 16px;
            }
            button:hover { background: #5568d3; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="success">✅</div>
            <h1>Autorización exitosa!</h1>
            <p>Tu app ha sido autorizada correctamente.</p>
            <div class="scopes">Scopes: ${tokenData.scope}</div>
            <p>Puedes cerrar esta ventana y regresar a tu aplicación.</p>
            <button onclick="window.close()">Cerrar</button>
          </div>
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

// API Routes
app.use('/api/items', itemsRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/shipments', shipmentsRouter);

// Schedule token refresh every hour
cron.schedule('0 * * * *', async () => {
  console.log('🔄 Running scheduled token refresh check...');
  if (mlAuth.hasValidToken() && mlAuth.isTokenExpired()) {
    try {
      await mlAuth.refreshAccessToken();
      console.log('✅ Token refreshed successfully');
    } catch (error) {
      console.error('❌ Error refreshing token:', error);
    }
  }
});

// Error handling middleware
app.use((err: any, req: Request, res: Response, next: any) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: err.message,
  });
});

// Start server
app.listen(PORT, () => {
  console.log('\n🚀 MercadoLibre Dashboard Backend Server');
  console.log(`📡 Server running on http://localhost:${PORT}`);
  console.log(`🔐 CORS enabled for: http://localhost:4200\n`);

  if (!mlAuth.hasValidToken()) {
    console.log('⚠️  No valid token found!');
    console.log(`🔑 Please authorize the app by visiting: http://localhost:${PORT}/auth\n`);
  } else {
    console.log('✅ Valid token found. Ready to serve requests!\n');
  }
});
