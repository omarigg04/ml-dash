import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { mlAuth } from '../backend/src/auth/oauth';
import ordersRouter from '../backend/src/routes/orders';
import shipmentsRouter from '../backend/src/routes/shipments';

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

// OAuth authorization endpoint
app.get('/api/auth', (req, res) => {
  const authUrl = mlAuth.getAuthorizationUrl();
  res.redirect(authUrl);
});

// OAuth callback endpoint
app.get('/api/callback', async (req, res) => {
  const { code } = req.query;

  if (!code || typeof code !== 'string') {
    res.status(400).send('Authorization code not found');
    return;
  }

  try {
    await mlAuth.getAccessToken(code);
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
            <a href="/">Ir al Dashboard</a>
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
app.use('/api/orders', ordersRouter);
app.use('/api/shipments', shipmentsRouter);

// Error handling middleware
app.use((err: any, req: any, res: any, next: any) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: err.message,
  });
});

// Export for Vercel serverless
export default app;
