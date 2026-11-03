import axios from 'axios';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { TokenData } from '../types';
import { isAllowedId } from './allowlist';
import { currentUid } from './context';

// Tokens por cuenta: `meli_oauth_token_v2:<uid>`. La clave anterior (un solo token global, el del dueño)
// se sigue LEYENDO y ESCRIBIENDO (doble escritura) mientras sea del mismo uid, para poder volver a un
// despliegue anterior sin perder el login (los refresh tokens de ML son de un solo uso).
// Se puede dejar de leer/escribir y borrar LEGACY_TOKEN_KV_KEY cuando ya no exista ningún despliegue
// previo a multi-cuenta al que se quiera volver (p. ej. un par de semanas después de estabilizar).
const LEGACY_TOKEN_KV_KEY = 'meli_oauth_token_v2';
const tokenKvKey = (uid: string) => `${LEGACY_TOKEN_KV_KEY}:${uid}`;
const TOKEN_DIR = path.join(__dirname, '../../');
// Archivo local (solo desarrollo sin KV): tokens.json = legado, tokens.<uid>.json = por cuenta
const tokenFile = (key: string) =>
    path.join(TOKEN_DIR, key === LEGACY_TOKEN_KV_KEY ? 'tokens.json' : `tokens.${key.slice(LEGACY_TOKEN_KV_KEY.length + 1)}.json`);

// Helper to interact with Vercel KV via REST API using fetch
// This avoids dependency issues with @vercel/kv package
const kvRestApi = async (method: string, params: any[] = []) => {
    const url = process.env['KV_REST_API_URL'];
    const token = process.env['KV_REST_API_TOKEN'];

    if (!url || !token) {
        throw new Error('KV env vars missing (KV_REST_API_URL / KV_REST_API_TOKEN)');
    }

    // Upstash/Vercel KV REST API: POST / with the command as a JSON array.
    // Errors are thrown (not swallowed) so a broken store is visible instead
    // of tokens silently living only in one instance's memory
    const response = await fetch(`${url}/`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(params),
    });

    if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`KV REST API Error: ${response.status} ${response.statusText} ${body}`);
    }

    const data = await response.json() as any;
    return data.result;
};

/**
 * Check that the token store (KV) is reachable
 */
export const checkTokenStorage = async (): Promise<{ ok: boolean; error?: string }> => {
    if (!process.env['KV_REST_API_URL']) {
        return { ok: false, error: 'KV_REST_API_URL not set' };
    }
    try {
        await kvRestApi('POST', ['PING']);
        return { ok: true };
    } catch (error: any) {
        return { ok: false, error: error.message };
    }
};

export class UserNotAllowedError extends Error {
    constructor(public userId: number) {
        super(`MercadoLibre user ${userId} is not allowed (ALLOWED_ML_USER_ID)`);
    }
}

export class TokenStorageError extends Error {}

const isServerless = (): boolean => !!process.env['VERCEL'] || !!process.env['AWS_LAMBDA_FUNCTION_NAME'];

const parseToken = (raw: any): TokenData | null => {
    try {
        const t = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return t && typeof t === 'object' ? t as TokenData : null;
    } catch {
        return null;
    }
};

/** Lee una clave (KV, o archivo local si no es serverless). failed = KV erró y no hubo respaldo. Nunca escribe. */
const readKey = async (key: string): Promise<{ data: TokenData | null; failed: boolean }> => {
    let failed = false;
    if (process.env['KV_REST_API_URL']) {
        try {
            const result = await kvRestApi('POST', ['GET', key]);
            if (result) return { data: parseToken(result), failed: false };
        } catch (error) {
            failed = true;
            console.log('⚠️  Error loading tokens from Vercel KV:', (error as any)?.message);
        }
    }
    if (!isServerless()) {
        try {
            const file = tokenFile(key);
            if (fs.existsSync(file)) return { data: parseToken(fs.readFileSync(file, 'utf-8')), failed: false };
        } catch {
            console.log('⚠️  No existing tokens found or error loading tokens');
        }
    }
    return { data: null, failed };
};

const writeKey = async (key: string, data: TokenData): Promise<void> => {
    if (process.env['KV_REST_API_URL']) {
        try {
            await kvRestApi('POST', ['SET', key, JSON.stringify(data)]);
            return;
        } catch (error) {
            console.error('Error saving tokens to Vercel KV:', (error as any)?.message);
            // On serverless there is no fallback: the token would be lost
            if (isServerless()) throw new TokenStorageError((error as Error).message);
        }
    } else if (isServerless()) {
        throw new TokenStorageError('No token storage configured (KV_REST_API_URL missing)');
    }
    try {
        fs.writeFileSync(tokenFile(key), JSON.stringify(data, null, 2));
    } catch (error) {
        console.error('Error saving tokens:', (error as any)?.message);
    }
};

const deleteKey = async (key: string): Promise<void> => {
    if (process.env['KV_REST_API_URL']) {
        try {
            await kvRestApi('POST', ['DEL', key]);
        } catch (error) {
            console.error('Error clearing tokens from Vercel KV:', (error as any)?.message);
        }
    }
    if (!isServerless()) {
        try {
            const file = tokenFile(key);
            if (fs.existsSync(file)) fs.unlinkSync(file);
        } catch (error) {
            console.error('Error clearing tokens from file:', (error as any)?.message);
        }
    }
};

/**
 * El token pertenece a uid. requireUserId=true (clave heredada): sin user_id jamás se acepta.
 * Clave por uid: sin user_id se acepta (la escribimos nosotros), pero si dice otra cuenta se rechaza.
 */
const belongsTo = (t: TokenData | null, uid: string, requireUserId: boolean): t is TokenData => {
    if (!t || typeof t.access_token !== 'string') return false;
    if (t.user_id === undefined || t.user_id === null) return !requireUserId;
    return String(t.user_id) === uid;
};

// Espera antes de releer KV tras un invalid_grant o un token recién guardado (ajustable en pruebas)
let RECOVERY_WAIT_MS = 1000;
export const __setRecoveryWaitForTests = (ms: number) => { RECOVERY_WAIT_MS = ms; };

export class MercadoLibreAuth {
    // Todo el estado es POR CUENTA (uid): una cuenta nunca lee ni toca el token, el refresh o el borrado de otra.
    private tokens = new Map<string, TokenData>();
    private refreshPromises = new Map<string, Promise<TokenData>>();

    private get appId(): string {
        return process.env['APP_ID'] || '';
    }

    private get appSecret(): string {
        return process.env['APP_SECRET'] || '';
    }

    private get redirectUri(): string {
        return process.env['REDIRECT_URI'] || 'http://localhost:3000/callback';
    }

    /** Cuenta de la petición actual; lanza (=> 401) si no hay contexto o ya no está permitida. */
    private uid(): string {
        return currentUid();
    }

    /**
     * Generate authorization URL for OAuth 2.0 flow
     * Includes scopes for: offline access, read data, and write/publish items
     */
    getAuthorizationUrl(state?: string, codeChallenge?: string): string {
        // MercadoLibre only supports 3 scopes:
        // offline_access: to get refresh tokens
        // read: allows GET operations (read orders, items, shipments, etc.)
        // write: allows POST, PUT, DELETE operations (create/update/delete items, etc.)
        const scopes = [
            'offline_access',
            'read',
            'write'
        ].join(' ');
        const encodedScopes = encodeURIComponent(scopes);
        const encodedRedirectUri = encodeURIComponent(this.redirectUri);
        let url = `https://auth.mercadolibre.com.mx/authorization?response_type=code&client_id=${this.appId}&redirect_uri=${encodedRedirectUri}&scope=${encodedScopes}`;
        if (state) url += `&state=${encodeURIComponent(state)}`;
        if (codeChallenge) url += `&code_challenge=${encodeURIComponent(codeChallenge)}&code_challenge_method=S256`;
        return url;
    }

    /**
     * Generate a PKCE verifier/challenge pair and a random state
     */
    createPkce(): { state: string; verifier: string; challenge: string } {
        const verifier = crypto.randomBytes(32).toString('base64url');
        const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
        const state = crypto.randomBytes(16).toString('base64url');
        return { state, verifier, challenge };
    }

    /**
     * Exchange authorization code for access token.
     * No hay sesión todavía: el uid sale de la respuesta de ML y se guarda explícitamente, sin contexto.
     */
    async getAccessToken(code: string, codeVerifier?: string): Promise<TokenData> {
        try {
            console.log('[DEBUG] getting access token with ID:', this.appId ? 'FOUND' : 'MISSING');
            const params = new URLSearchParams({
                grant_type: 'authorization_code',
                client_id: this.appId,
                client_secret: this.appSecret,
                code: code,
                redirect_uri: this.redirectUri,
            });
            if (codeVerifier) params.append('code_verifier', codeVerifier);
            const response = await axios.post('https://api.mercadolibre.com/oauth/token', params);

            // Solo las cuentas de la lista permitida pueden entrar: de lo contrario cualquier usuario de ML
            // podría guardar su propio token
            if (!isAllowedId(response.data.user_id)) {
                throw new UserNotAllowedError(response.data.user_id);
            }
            const uid = String(response.data.user_id);

            const tokenData: TokenData = {
                ...response.data,
                created_at: Date.now(),
            };

            await this.saveTokens(uid, tokenData);
            this.tokens.set(uid, tokenData);
            console.log('✅ Access token obtained successfully');
            return tokenData;
        } catch (error: any) {
            console.error('Error getting access token:', error.response?.data || error.message);
            throw error;
        }
    }

    /**
     * Refresh the access token of the request's account
     */
    async refreshAccessToken(): Promise<TokenData> {
        return this.refreshFor(this.uid());
    }

    private refreshFor(uid: string): Promise<TokenData> {
        // MercadoLibre refresh tokens are single-use: share one in-flight refresh PER ACCOUNT
        // so concurrent requests don't burn the token twice.
        let p = this.refreshPromises.get(uid);
        if (!p) {
            p = this.doRefresh(uid).finally(() => {
                this.refreshPromises.delete(uid);
            });
            this.refreshPromises.set(uid, p);
        }
        return p;
    }

    private async doRefresh(uid: string): Promise<TokenData> {
        // Another serverless instance may have already rotated the token
        await this.loadTokens(uid);
        const current = this.tokens.get(uid);
        if (current && !this.expired(current)) {
            return current;
        }

        if (!current?.refresh_token) {
            throw new Error('No refresh token available');
        }

        try {
            const response = await axios.post('https://api.mercadolibre.com/oauth/token', new URLSearchParams({
                grant_type: 'refresh_token',
                client_id: this.appId,
                client_secret: this.appSecret,
                refresh_token: current.refresh_token,
            }));

            // ML devuelve user_id en el refresh; si faltara se conserva el existente. Si dice otra cuenta, no se guarda.
            const returnedId = response.data?.user_id ?? current.user_id ?? Number(uid);
            if (String(returnedId) !== uid) {
                throw new Error('Refreshed token belongs to a different account');
            }
            const refreshed: TokenData = {
                ...response.data,
                user_id: returnedId,
                created_at: Date.now(),
            };

            this.tokens.set(uid, refreshed);
            await this.saveTokens(uid, refreshed);
            console.log('✅ Access token refreshed successfully');
            return refreshed;
        } catch (error: any) {
            console.error('Error refreshing token:', error.response?.data || error.message);
            if (error.response?.data?.error === 'invalid_grant') {
                // Another instance may have rotated the token (new login or a
                // concurrent refresh): use the stored one instead of wiping it
                const usedRefreshToken = current.refresh_token;
                await new Promise(resolve => setTimeout(resolve, RECOVERY_WAIT_MS));
                await this.loadTokens(uid);
                const reloaded = this.tokens.get(uid);
                if (reloaded && reloaded.refresh_token !== usedRefreshToken) {
                    return reloaded;
                }

                // Refresh token revoked or expired: the user must re-authorize
                await this.clearFor(uid);
                throw new Error('Authorization expired. Please re-authorize the app.');
            }
            throw error;
        }
    }

    private expired(t: TokenData | undefined): boolean {
        if (!t) return true;
        const expirationTime = t.created_at + (t.expires_in * 1000);
        const fiveMinutes = 5 * 60 * 1000;
        return Date.now() >= (expirationTime - fiveMinutes);
    }

    /**
     * Check if token is expired or about to expire (within 5 minutes)
     */
    isTokenExpired(): boolean {
        return this.expired(this.tokens.get(this.uid()));
    }

    /**
     * Get current access token of the request's account, refreshing if necessary.
     * Lanza si no hay cuenta en el contexto: jamás se usa un token por defecto.
     */
    async getToken(): Promise<string> {
        const uid = this.uid();

        if (!this.tokens.has(uid)) {
            await this.loadTokens(uid);
        }

        // A token just saved by another serverless instance (e.g. right after
        // login) may take a moment to be readable from KV: retry once
        if (!this.tokens.has(uid) && process.env['KV_REST_API_URL']) {
            await new Promise(resolve => setTimeout(resolve, RECOVERY_WAIT_MS));
            await this.loadTokens(uid);
        }

        let token = this.tokens.get(uid);
        if (!token) {
            throw new Error('No token available. Please authorize the app first.');
        }

        if (this.expired(token)) {
            console.log('🔄 Token expired, refreshing...');
            token = await this.refreshFor(uid);
        }

        return token.access_token;
    }

    /**
     * Check if we have a valid token
     */
    hasValidToken(): boolean {
        const t = this.tokens.get(this.uid());
        return !!t && !this.expired(t);
    }

    /**
     * Whether a token (possibly expired but refreshable) is stored
     */
    async isConnected(): Promise<boolean> {
        const uid = this.uid();
        if (!this.tokens.has(uid)) {
            await this.loadTokens(uid);
        }
        return !!this.tokens.get(uid)?.refresh_token;
    }

    /**
     * Carga el token de uid. Lee la clave por uid y la heredada; la heredada solo cuenta si su user_id es uid.
     * Gana la de created_at más reciente (empate: la de uid). Una lectura NUNCA escribe en KV.
     */
    private async loadTokens(uid: string): Promise<void> {
        const perUid = await readKey(tokenKvKey(uid));
        const legacy = await readKey(LEGACY_TOKEN_KV_KEY);
        // Si alguna lectura falló no se decide con datos parciales: se conserva lo que haya en memoria
        if (perUid.failed || legacy.failed) return;

        const a = belongsTo(perUid.data, uid, false) ? perUid.data : null;
        const b = belongsTo(legacy.data, uid, true) ? legacy.data : null;
        let chosen: TokenData | null = a;
        if (b && (!a || (b.created_at || 0) > (a.created_at || 0))) chosen = b;
        if (chosen) {
            this.tokens.set(uid, chosen);
            console.log('✅ Tokens loaded');
        } else {
            console.log('[DEBUG] No token found in storage');
        }
    }

    /**
     * Guarda el token de uid en su clave. Si la clave heredada pertenece al MISMO uid también se escribe
     * (doble escritura) para que un rollback a un despliegue anterior siga funcionando. Nunca se borra aquí.
     */
    private async saveTokens(uid: string, data: TokenData): Promise<void> {
        await writeKey(tokenKvKey(uid), data);
        try {
            const legacy = await readKey(LEGACY_TOKEN_KV_KEY);
            if (!legacy.failed && belongsTo(legacy.data, uid, true)) {
                await writeKey(LEGACY_TOKEN_KV_KEY, data);
            }
        } catch (error) {
            // Solo afecta al rollback; el token por uid ya quedó guardado
            console.error('Legacy token dual-write failed:', (error as any)?.message);
        }
        console.log('✅ Tokens saved');
    }

    /**
     * Clear tokens of the request's account (for re-authorization)
     */
    async clearTokens(): Promise<void> {
        await this.clearFor(this.uid());
    }

    private async clearFor(uid: string): Promise<void> {
        this.tokens.delete(uid);
        await deleteKey(tokenKvKey(uid));
        // El token heredado del mismo uid está muerto igual: si no se borrara, resucitaría en la siguiente lectura
        const legacy = await readKey(LEGACY_TOKEN_KV_KEY);
        if (!legacy.failed && belongsTo(legacy.data, uid, true)) {
            await deleteKey(LEGACY_TOKEN_KV_KEY);
        }
    }

}

export const mlAuth = new MercadoLibreAuth();
