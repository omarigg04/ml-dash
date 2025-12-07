import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import cron from 'node-cron';
import { mlAuth } from './auth/oauth';
import ordersRouter from './routes/orders';
import shipmentsRouter from './routes/shipments';
import itemsRouter from './routes/items';

// Load environment variables
dotenv.config();

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

// OAuth authorization endpoint
app.get('/auth', (req: Request, res: Response) => {
  const authUrl = mlAuth.getAuthorizationUrl();
  res.redirect(authUrl);
});

// OAuth callback endpoint
app.get('/callback', async (req: Request, res: Response) => {
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
