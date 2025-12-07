import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { TokenData } from '../types';

const TOKEN_FILE = path.join(__dirname, '../../tokens.json');

export class MercadoLibreAuth {
    private appId: string;
    private appSecret: string;
    private redirectUri: string;
    private tokenData: TokenData | null = null;

    constructor() {
        this.appId = process.env['APP_ID'] || '';
        this.appSecret = process.env['APP_SECRET'] || '';
        this.redirectUri = process.env['REDIRECT_URI'] || 'http://localhost:3000/callback';
        this.loadTokens();
    }

    /**
     * Generate authorization URL for OAuth 2.0 flow
     */
    getAuthorizationUrl(): string {
        return `https://auth.mercadolibre.com.mx/authorization?response_type=code&client_id=${this.appId}&redirect_uri=${this.redirectUri}`;
    }

    /**
     * Exchange authorization code for access token
     */
    async getAccessToken(code: string): Promise<TokenData> {
        try {
            const response = await axios.post('https://api.mercadolibre.com/oauth/token', {
                grant_type: 'authorization_code',
                client_id: this.appId,
                client_secret: this.appSecret,
                code: code,
                redirect_uri: this.redirectUri,
            });

            this.tokenData = {
                ...response.data,
                created_at: Date.now(),
            };

            this.saveTokens();
            console.log('✅ Access token obtained successfully');
            return this.tokenData;
        } catch (error: any) {
            console.error('Error getting access token:', error.response?.data || error.message);
            throw error;
        }
    }

    /**
     * Refresh the access token using refresh token
     */
    async refreshAccessToken(): Promise<TokenData> {
        if (!this.tokenData?.refresh_token) {
            throw new Error('No refresh token available');
        }

        try {
            const response = await axios.post('https://api.mercadolibre.com/oauth/token', {
                grant_type: 'refresh_token',
                client_id: this.appId,
                client_secret: this.appSecret,
                refresh_token: this.tokenData.refresh_token,
            });

            this.tokenData = {
                ...response.data,
                created_at: Date.now(),
            };

            this.saveTokens();
            console.log('✅ Access token refreshed successfully');
            return this.tokenData;
        } catch (error: any) {
            console.error('Error refreshing token:', error.response?.data || error.message);
            throw error;
        }
    }

    /**
     * Check if token is expired or about to expire (within 5 minutes)
     */
    isTokenExpired(): boolean {
        if (!this.tokenData) return true;

        const expirationTime = this.tokenData.created_at + (this.tokenData.expires_in * 1000);
        const now = Date.now();
        const fiveMinutes = 5 * 60 * 1000;

        return now >= (expirationTime - fiveMinutes);
    }

    /**
     * Get current access token, refreshing if necessary
     */
    async getToken(): Promise<string> {
        if (!this.tokenData) {
            throw new Error('No token available. Please authorize the app first.');
        }

        if (this.isTokenExpired()) {
            console.log('🔄 Token expired, refreshing...');
            await this.refreshAccessToken();
        }

        return this.tokenData.access_token;
    }

    /**
     * Check if we have a valid token
     */
    hasValidToken(): boolean {
        return this.tokenData !== null && !this.isTokenExpired();
    }

    /**
     * Check if running in Vercel serverless environment
     */
    private isServerless(): boolean {
        return !!process.env['VERCEL'] || !!process.env['AWS_LAMBDA_FUNCTION_NAME'];
    }

    /**
     * Load tokens from file (only in local environment)
     */
    private loadTokens(): void {
        if (this.isServerless()) {
            console.log('📦 Running in serverless environment - tokens will be stored in memory only');
            return;
        }

        try {
            if (fs.existsSync(TOKEN_FILE)) {
                const data = fs.readFileSync(TOKEN_FILE, 'utf-8');
                this.tokenData = JSON.parse(data);
                console.log('✅ Tokens loaded from file');
            }
        } catch (error) {
            console.log('⚠️  No existing tokens found or error loading tokens');
        }
    }

    /**
     * Save tokens to file (only in local environment)
     */
    private saveTokens(): void {
        if (this.isServerless()) {
            console.log('📦 Serverless environment - tokens stored in memory (not persisted)');
            return;
        }

        try {
            fs.writeFileSync(TOKEN_FILE, JSON.stringify(this.tokenData, null, 2));
            console.log('✅ Tokens saved to file');
        } catch (error) {
            console.error('Error saving tokens:', error);
        }
    }
}

export const mlAuth = new MercadoLibreAuth();