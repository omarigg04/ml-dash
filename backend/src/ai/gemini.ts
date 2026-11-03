import { GoogleGenAI } from '@google/genai';
import { AiError, AiProvider, ProviderRequest, ProviderResult } from './errors';

/**
 * Proveedor por defecto: Google Gemini API (plan gratuito, clave de Google AI Studio sin tarjeta).
 * Usa el SDK oficial @google/genai con la Interactions API y salida JSON con esquema, como en la
 * documentación oficial (ai.google.dev, "Structured outputs"). La salida SIEMPRE se vuelve a validar con zod.
 */
export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';
const TIMEOUT_MS = 45_000;

export const geminiModel = (): string => process.env['GEMINI_MODEL']?.trim() || DEFAULT_GEMINI_MODEL;

/** Lo mínimo del SDK que usamos; permite inyectar un cliente falso en pruebas (sin red). */
export interface GeminiClient {
    interactions: { create(params: any, options?: any): Promise<any> };
}

let injected: GeminiClient | null = null;
let real: GeminiClient | null = null;
export const __setGeminiClientForTests = (c: GeminiClient | null) => { injected = c; real = null; };

const keyPresent = (): boolean => !!process.env['GEMINI_API_KEY']?.trim();

const getClient = (): GeminiClient => {
    if (injected) return injected;
    if (!keyPresent()) {
        throw new AiError(503, 'AI_NOT_CONFIGURED', 'Falta configurar la clave de Gemini (GEMINI_API_KEY) en el servidor. El resto de la página sigue funcionando.');
    }
    if (!real) real = new GoogleGenAI({ apiKey: process.env['GEMINI_API_KEY']!.trim() }) as unknown as GeminiClient;
    return real;
};

/** JSON Schema para Gemini: sin la clave $schema (no forma parte del subconjunto documentado). */
export const toGeminiSchema = (jsonSchema: any): any => {
    const { $schema, ...rest } = jsonSchema ?? {};
    return rest;
};

export const geminiProvider: AiProvider = {
    name: 'gemini',
    configured: () => !!injected || keyPresent(),
    async generate(req: ProviderRequest): Promise<ProviderResult> {
        const client = getClient();
        const model = geminiModel();
        let interaction: any;
        try {
            const call = client.interactions.create({
                model,
                input: req.user,
                system_instruction: req.system,
                store: false,                                   // no guardar la interacción en el servidor de Google
                response_format: { type: 'text', mime_type: 'application/json', schema: toGeminiSchema(req.jsonSchema) },
            }, { timeout_ms: TIMEOUT_MS, retries: { strategy: 'none' } });   // sin reintentos: un 429 no se repite en bucle
            interaction = await Promise.race([
                call,
                new Promise((_, rej) => req.signal.addEventListener('abort', () => rej(Object.assign(new Error('timeout'), { name: 'TimeoutError' })))),
            ]);
        } catch (e) {
            throw mapGeminiError(e);
        }
        const u = interaction?.usage ?? {};
        const usage = { input_tokens: Number(u.total_input_tokens) || 0, output_tokens: Number(u.total_output_tokens) || 0 };
        if (interaction?.status === 'incomplete') return { candidate: null, stop: 'truncated', usage, model };
        const text = String(interaction?.output_text ?? '').trim();
        if (!text) return { candidate: null, stop: 'ok', usage, model };      // vacío: la capa común lo trata como formato inválido
        let candidate: unknown = null;
        try { candidate = JSON.parse(text); } catch { candidate = null; }
        return { candidate, stop: 'ok', usage, model };
    },
};

/** Errores de Gemini a respuestas amables. Nunca incluye el texto del prompt ni la clave. */
export function mapGeminiError(e: unknown): AiError {
    if (e instanceof AiError) return e;
    const anyE = e as any;
    const status = Number(anyE?.status ?? anyE?.code ?? anyE?.statusCode) || 0;
    const msg = String(anyE?.message ?? '');
    if (status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(msg)) {
        return new AiError(429, 'AI_QUOTA_FREE', 'Se agotó la cuota gratuita de hoy en Gemini. Intenta más tarde (se renueva con el tiempo) o mañana.');
    }
    if (status === 401 || status === 403 || /API key not valid|PERMISSION_DENIED|UNAUTHENTICATED/i.test(msg)) {
        return new AiError(502, 'AI_AUTH', 'La clave de Gemini del servidor no es válida o no tiene permiso. Revísala en la configuración.');
    }
    if (anyE?.name === 'TimeoutError' || anyE?.name === 'AbortError' || /timed? ?out/i.test(msg)) {
        return new AiError(504, 'AI_TIMEOUT', 'Gemini tardó demasiado en responder. Intenta de nuevo.');
    }
    if (status === 400) return new AiError(502, 'AI_BAD_REQUEST', 'Gemini rechazó la solicitud. Intenta de nuevo más tarde.');
    if (status >= 500) return new AiError(503, 'AI_OVERLOADED', 'Gemini no está disponible por ahora. Intenta de nuevo en unos minutos.');
    if (status === 0 && /fetch failed|ECONN|ENOTFOUND|network/i.test(msg)) {
        return new AiError(502, 'AI_CONNECTION', 'No se pudo conectar con Gemini. Intenta de nuevo en unos minutos.');
    }
    return new AiError(502, 'AI_ERROR', `Gemini devolvió un error${status ? ` (${status})` : ''}.`);
}
