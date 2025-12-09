import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { TokenData } from '../types';

const TOKEN_FILE = path.join(__dirname, '../../tokens.json');
const TOKEN_KV_KEY = 'meli_oauth_token_v2';

// Helper to interact with Vercel KV via REST API using fetch
// This avoids dependency issues with @vercel/kv package
const kvRestApi = async (method: string, params: any[] = []) => {
    const url = process.env['KV_REST_API_URL'];
    const token = process.env['KV_REST_API_TOKEN'];

    if (!url || !token) {
        console.log('[DEBUG] KV Env Vars missing');
        return null;
    }

    try {
        // Append command to URL for Upstash/Vercel KV REST API
        // e.g. https://.../mget/key1/key2 or just set/get
        // For simple commands: POST /
        const response = await fetch(`${url}/`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify(params),
        });

        if (!response.ok) {
            console.log(`[DEBUG] KV REST API Error: ${response.status} ${response.statusText}`);
            return null;
        }

        const data = await response.json() as any;
        return data.result;
    } catch (error) {
        console.log('[DEBUG] KV Fetch Error:', error);
        return null;
    }
};

export class MercadoLibreAuth {
    // Removed cached properties to force dynamic lookup
    // private appId: string;
    // private appSecret: string;
    // private redirectUri: string;
    private tokenData: TokenData | null = null;

    constructor() {
        // We do not load tokens in constructor anymore, they are lazy loaded
    }

    private get appId(): string {
        return process.env['APP_ID'] || '';
    }

    private get appSecret(): string {
        return process.env['APP_SECRET'] || '';
    }

    private get redirectUri(): string {
        return process.env['REDIRECT_URI'] || 'http://localhost:3000/callback';
    }

    /**
     * Generate authorization URL for OAuth 2.0 flow
     * Includes scopes for: offline access, read data, and write/publish items
     */
    getAuthorizationUrl(): string {
        // offline_access: to get refresh tokens
        // read, write: generic scopes (legacy/fallback)
        // items.read, items.write: granular scopes for items
        // orders.read: granular scope for orders
        // shipments.read: granular scope for shipments
        const scopes = [
            'offline_access',
            'read',
            'write',
            'items.read',
            'items.write',
            'orders.read',
            'shipments.read'
        ].join(' ');
        const encodedScopes = encodeURIComponent(scopes);
        const encodedRedirectUri = encodeURIComponent(this.redirectUri);
        return `https://auth.mercadolibre.com.mx/authorization?response_type=code&client_id=${this.appId}&redirect_uri=${encodedRedirectUri}&scope=${encodedScopes}`;
    }

    /**
     * Exchange authorization code for access token
     */
    async getAccessToken(code: string): Promise<TokenData> {
        try {
            console.log('[DEBUG] getting access token with ID:', this.appId ? 'FOUND' : 'MISSING');
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

            await this.saveTokens();
            console.log('✅ Access token obtained successfully');
            console.log('🔍 Granted Scopes:', this.tokenData?.scope); // Debug log
            return this.tokenData!;
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

            await this.saveTokens();
            console.log('✅ Access token refreshed successfully');
            return this.tokenData!;
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
        // Ensure tokens are loaded
        if (!this.tokenData) {
            await this.loadTokensAsync();
        }

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
     * Load tokens from Vercel KV (serverless) or file (local)
     */
    private async loadTokensAsync(): Promise<void> {
        console.log('[DEBUG] Starting loadTokensAsync (fetch mode)...');

        // Try Vercel KV via REST API
        if (process.env['KV_REST_API_URL']) {
            console.log('[DEBUG] KV URL found, attempting fetch...');
            try {
                // Command: ["GET", "key"]
                const result = await kvRestApi('POST', ['GET', TOKEN_KV_KEY]);
                console.log('[DEBUG] KV Fetch Result type:', typeof result);

                if (result) {
                    // Upstash returns the string value, we need to parse it if it's JSON
                    // But if we stored it as JSON/Object using SET command, it might come back as string or object
                    this.tokenData = typeof result === 'string' ? JSON.parse(result) : result;
                    console.log('✅ Tokens loaded from Vercel KV (REST)');
                    return;
                } else {
                    console.log('[DEBUG] No token found in KV');
                }
            } catch (error) {
                console.log('⚠️  Error loading tokens from Vercel KV:', error);
            }
        }

        // Fallback to file storage for local development
        if (!this.isServerless()) {
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
    }

    /**
     * Save tokens to Vercel KV (serverless) or file (local)
     */
    private async saveTokens(): Promise<void> {
        // Try Vercel KV via REST API
        if (process.env['KV_REST_API_URL']) {
            try {
                // Command: ["SET", "key", "value"]
                // We stringify the token data to ensure safe storage
                const value = JSON.stringify(this.tokenData);
                await kvRestApi('POST', ['SET', TOKEN_KV_KEY, value]);
                console.log('✅ Tokens saved to Vercel KV (REST)');
                return;
            } catch (error) {
                console.error('Error saving tokens to Vercel KV:', error);
            }
        }

        // Fallback to file storage for local development
        if (!this.isServerless()) {
            try {
                fs.writeFileSync(TOKEN_FILE, JSON.stringify(this.tokenData, null, 2));
                console.log('✅ Tokens saved to file');
            } catch (error) {
                console.error('Error saving tokens:', error);
            }
        }
    }
}

export const mlAuth = new MercadoLibreAuth();