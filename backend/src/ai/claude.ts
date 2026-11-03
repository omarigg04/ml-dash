import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { AiError, AiProvider, ProviderRequest, ProviderResult } from './errors';

export const AI_MODEL = 'claude-opus-5-5';
export const AI_MAX_TOKENS = 16000;
/** Modelo barato para el botón "Proponer títulos para todas" (Cargas masivas). */
export const BULK_TITLES_MODEL = 'claude-haiku-5-5';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const CLIENT_TIMEOUT_MS = 50_000;
/** Vercel corta a los 60 s (vercel.json): se aborta antes para poder responder con un mensaje claro. */
const OVERALL_DEADLINE_MS = 55_000;

/** Lo mínimo del SDK que usamos; permite inyectar un cliente falso en pruebas (sin red). */
export interface AiClient {
    beta: { messages: { parse(params: any, options?: any): Promise<any> } };
}


let injected: AiClient | null = null;
let real: AiClient | null = null;
export const __setAiClientForTests = (c: AiClient | null) => { injected = c; real = null; };

export const anthropicKeyConfigured = (): boolean => !!injected || !!process.env['ANTHROPIC_API_KEY']?.trim();

/**
 * Proveedor Anthropic: OPCIONAL y de pago. Solo se usa con AI_PROVIDER=anthropic y ANTHROPIC_API_KEY.
 * Cliente creado de forma perezosa: sin clave no se construye nada.
 */
const getClient = (): AiClient => {
    if (injected) return injected;
    if (!process.env['ANTHROPIC_API_KEY']?.trim()) {
        throw new AiError(503, 'AI_NOT_CONFIGURED', 'Falta configurar la clave de Claude (ANTHROPIC_API_KEY) en el servidor.');
    }
    if (!real) real = new Anthropic({ timeout: CLIENT_TIMEOUT_MS, maxRetries: 1 }) as unknown as AiClient;
    return real;
};


export const anthropicProvider: AiProvider = {
    name: 'anthropic',
    configured: anthropicKeyConfigured,
    async generate(req: ProviderRequest): Promise<ProviderResult> {
        const { system, user, schema, opts, signal } = req;
        const client = getClient();
        const custom = !!opts.model && opts.model !== AI_MODEL;
        const model = opts.model ?? AI_MODEL;
        const params: any = {
            model,
            max_tokens: opts.maxTokens ?? AI_MAX_TOKENS,
            system,
            messages: [{ role: 'user', content: user }],
            output_config: { effort: opts.effort ?? 'medium', format: zodOutputFormat(schema) },
        };
        if (!custom) { params.fallbacks = 'default'; params.betas = [FALLBACK_BETA]; }
        let msg: any;
        try {
            msg = await client.beta.messages.parse(params, { signal });
        } catch (e) {
            throw mapAiError(e);
        }
        const usage = { input_tokens: Number(msg?.usage?.input_tokens) || 0, output_tokens: Number(msg?.usage?.output_tokens) || 0 };
        if (msg?.stop_reason === 'refusal') return { candidate: null, stop: 'refusal', usage, model };
        if (msg?.stop_reason === 'max_tokens') return { candidate: null, stop: 'truncated', usage, model };
        let candidate: unknown = msg?.parsed_output ?? null;
        if (candidate === null) {
            const text = (Array.isArray(msg?.content) ? msg.content : []).filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('');
            try { candidate = JSON.parse(text); } catch { candidate = null; }
        }
        return { candidate, stop: 'ok', usage, model };
    },
};

/** Errores del SDK (de lo más específico a lo más general) a respuestas amables. */
export function mapAiError(e: unknown): AiError {
    if (e instanceof AiError) return e;
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
        return new AiError(502, 'AI_AUTH', 'La clave de Claude del servidor no es válida o no tiene permiso. Revísala en la configuración.');
    }
    if (e instanceof Anthropic.RateLimitError) {
        return new AiError(429, 'AI_RATE_LIMITED', 'Claude está recibiendo demasiadas solicitudes. Espera un momento e intenta de nuevo.');
    }
    if (e instanceof Anthropic.BadRequestError) {
        return new AiError(502, 'AI_BAD_REQUEST', 'Claude rechazó la solicitud (puede ser saldo insuficiente o una petición inválida).');
    }
    if (e instanceof Anthropic.APIConnectionTimeoutError || (e as any)?.name === 'TimeoutError' || (e as any)?.name === 'AbortError') {
        return new AiError(504, 'AI_TIMEOUT', 'Claude tardó demasiado en responder. Intenta de nuevo.');
    }
    if (e instanceof Anthropic.APIConnectionError) {
        return new AiError(502, 'AI_CONNECTION', 'No se pudo conectar con Claude. Intenta de nuevo en unos minutos.');
    }
    if (e instanceof Anthropic.InternalServerError || (e instanceof Anthropic.APIError && (e as any).status === 529)) {
        return new AiError(503, 'AI_OVERLOADED', 'Claude no está disponible por ahora. Intenta de nuevo en unos minutos.');
    }
    if (e instanceof Anthropic.APIError) {
        return new AiError(502, 'AI_ERROR', `Claude devolvió un error (${(e as any).status ?? 's/n'}).`);
    }
    return new AiError(502, 'AI_ERROR', 'No se pudo generar la sugerencia.');
}
