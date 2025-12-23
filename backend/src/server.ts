import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import cron from 'node-cron';
import axios from 'axios';
import { mlAuth } from './auth/oauth';

// Import our new auth middleware and service
import { authMiddleware } from './middleware/auth';
// import { appwriteService } from './auth/appwrite'; // Not directly used here, but good to have reference. Removing for now.

// Import routes
import ordersRouter from './routes/orders';
import shipmentsRouter from './routes/shipments';
import itemsRouter from './routes/items';
import imagesRouter from './routes/images';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// IMPORTANTE: CORS debe ir ANTES que Helmet
app.use(cors({
  origin: [
    'http://localhost:4200',
    'https://omargaxiola.com',
    'https://mercado-libre-dashboard.vercel.app'
  ],
  credentials: true
}));

// Security Middleware (Helmet con configuración para permitir CORS)
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 100, // límite de 100 requests por IP
  message: 'Too many requests from this IP, please try again later.'
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============================================
// PUBLIC ROUTES (sin autenticación)
// ============================================

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============================================
// PROTECTED ROUTES (requieren autenticación)
// ============================================

// Aplicar middleware de autenticación a TODAS las rutas /api/*
// TEMPORALMENTE DESHABILITADO: Appwrite JWT tiene rate limiting muy agresivo
// TODO: Implementar caché de peticiones y reactivar autenticación
// app.use('/api', apiLimiter, authMiddleware); // Apply rate limiter before auth
app.use('/api', apiLimiter); // Solo rate limiter por ahora

// Montar routers protegidos
app.use('/api/orders', ordersRouter);
app.use('/api/shipments', shipmentsRouter);
app.use('/api/items', itemsRouter);
app.use('/api/images', imagesRouter);

// Endpoint de validación de sesión
app.get('/api/auth/session', (req, res) => {
  res.json({
    user: (req as any).user,
    authenticated: true
  });
});

// ============================================
// PUBLIC ML AUTH ROUTES (Still needed)
// ============================================

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

// ============================================
// ERROR HANDLING
// ============================================

app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: err.message
  });
});

// ============================================
// START SERVER
// ============================================

const PORT = process.env.PORT || 3000;

if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

export default app;
