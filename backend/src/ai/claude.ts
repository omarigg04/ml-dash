import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type * as z from 'zod/v4';

export const AI_MODEL = 'claude-opus-5-5';
export const AI_MAX_TOKENS = 16000;
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const CLIENT_TIMEOUT_MS = 50_000;
/** Vercel corta a los 60 s (vercel.json): se aborta antes para poder responder con un mensaje claro. */
const OVERALL_DEADLINE_MS = 55_000;

/** Lo mínimo del SDK que usamos; permite inyectar un cliente falso en pruebas (sin red). */
export interface AiClient {
    beta: { messages: { parse(params: any, options?: any): Promise<any> } };
}

export class AiError extends Error {
    constructor(public status: number, public code: string, message: string) { super(message); }
}

let injected: AiClient | null = null;
let real: AiClient | null = null;
export const __setAiClientForTests = (c: AiClient | null) => { injected = c; real = null; };

export const aiKeyConfigured = (): boolean => !!injected || !!process.env['ANTHROPIC_API_KEY']?.trim();

/** Cliente creado de forma perezosa: sin clave no se construye nada. */
const getClient = (): AiClient => {
    if (injected) return injected;
    if (!process.env['ANTHROPIC_API_KEY']?.trim()) {
        throw new AiError(503, 'AI_NOT_CONFIGURED', 'Falta configurar la clave de Claude (ANTHROPIC_API_KEY) en el servidor.');
    }
    if (!real) real = new Anthropic({ timeout: CLIENT_TIMEOUT_MS, maxRetries: 1 }) as unknown as AiClient;
    return real;
};

export interface AiUsage { input_tokens: number; output_tokens: number; }

/**
 * Llama a Claude con salida estructurada validada con zod. Thinking por defecto, esfuerzo medio y
 * reintento server-side ante rechazo (fallbacks: "default"). Revisa stop_reason antes de leer la salida.
 * No registra prompts, respuestas ni claves: solo los tokens de uso.
 */
export async function callStructured<S extends z.ZodType>(
    label: string, schema: S, system: string, user: string
): Promise<{ data: z.infer<S>; usage: AiUsage }> {
    const client = getClient();
    let msg: any;
    try {
        msg = await client.beta.messages.parse({
            model: AI_MODEL,
            max_tokens: AI_MAX_TOKENS,
            system,
            messages: [{ role: 'user', content: user }],
            fallbacks: 'default',
            betas: [FALLBACK_BETA],
            output_config: { effort: 'medium', format: zodOutputFormat(schema) },
        }, { signal: AbortSignal.timeout(OVERALL_DEADLINE_MS) });
    } catch (e) {
        throw mapAiError(e);
    }
    const usage: AiUsage = { input_tokens: Number(msg?.usage?.input_tokens) || 0, output_tokens: Number(msg?.usage?.output_tokens) || 0 };
    console.log(`ai:${label} tokens input=${usage.input_tokens} output=${usage.output_tokens}`);

    if (msg?.stop_reason === 'refusal') {
        throw new AiError(422, 'AI_REFUSAL', 'Claude no quiso responder a esta solicitud. Prueba con otra publicación o revisa el texto de la publicación.');
    }
    if (msg?.stop_reason === 'max_tokens') {
        throw new AiError(502, 'AI_TRUNCATED', 'La respuesta de Claude se cortó por longitud. Intenta de nuevo.');
    }
    // Se valida siempre con zod, venga o no parsed_output
    let candidate: unknown = msg?.parsed_output ?? null;
    if (candidate === null) {
        const text = (Array.isArray(msg?.content) ? msg.content : []).filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('');
        try { candidate = JSON.parse(text); } catch { candidate = null; }
    }
    const checked = schema.safeParse(candidate);
    if (!checked.success) {
        throw new AiError(502, 'AI_INVALID_OUTPUT', 'Claude devolvió una respuesta con formato inválido. Intenta de nuevo.');
    }
    return { data: checked.data, usage };
}

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
