import * as z from 'zod/v4';
import { AiError, AiProvider, AiUsage, CallOptions } from './errors';
import { geminiProvider, geminiModel, __setGeminiClientForTests } from './gemini';
import { anthropicProvider, __setAiClientForTests, mapAiError } from './claude';

export { AiError, AiUsage, CallOptions, __setGeminiClientForTests, __setAiClientForTests, mapAiError };
export { BULK_TITLES_MODEL } from './claude';

/** Vercel corta a los 60 s (vercel.json): se aborta antes para poder responder con un mensaje claro. */
const OVERALL_DEADLINE_MS = 55_000;

/**
 * Proveedor de IA elegido por AI_PROVIDER. Por defecto 'gemini' (plan gratuito).
 * 'anthropic' (de pago) solo corre si se pide explícitamente; cualquier otro valor deja la IA sin configurar.
 */
export function getProvider(): AiProvider | null {
    const name = (process.env['AI_PROVIDER']?.trim().toLowerCase()) || 'gemini';
    if (name === 'gemini') return geminiProvider;
    if (name === 'anthropic') return anthropicProvider;
    return null;
}

export const aiKeyConfigured = (): boolean => !!getProvider()?.configured();

export const providerName = (): string => getProvider()?.name ?? 'ninguno';
export { geminiModel };

/**
 * Llama al proveedor activo con salida estructurada y valida SIEMPRE con zod.
 * Registra solo el uso de tokens (si el proveedor lo informa); nunca prompts, respuestas ni claves.
 */
export async function callStructured<S extends z.ZodType>(
    label: string, schema: S, system: string, user: string, opts: CallOptions = {}
): Promise<{ data: z.infer<S>; usage: AiUsage; model: string; provider: string }> {
    const provider = getProvider();
    if (!provider || !provider.configured()) {
        throw new AiError(503, 'AI_NOT_CONFIGURED', provider?.name === 'anthropic'
            ? 'Falta configurar la clave de Claude (ANTHROPIC_API_KEY) en el servidor.'
            : 'Falta configurar la clave de Gemini (GEMINI_API_KEY) en el servidor. El resto de la página sigue funcionando.');
    }
    const jsonSchema = z.toJSONSchema(schema as any);
    const res = await provider.generate({ label, system, user, schema, jsonSchema, opts, signal: AbortSignal.timeout(OVERALL_DEADLINE_MS) });
    console.log(`ai:${label} provider=${provider.name} tokens input=${res.usage.input_tokens} output=${res.usage.output_tokens}`);

    if (res.stop === 'refusal') {
        throw new AiError(422, 'AI_REFUSAL', 'La IA no quiso responder a esta solicitud. Prueba con otra publicación o revisa el texto de la publicación.');
    }
    if (res.stop === 'truncated') {
        throw new AiError(502, 'AI_TRUNCATED', 'La respuesta de la IA se cortó por longitud. Intenta de nuevo.');
    }
    const checked = (schema as z.ZodType).safeParse(res.candidate);
    if (!checked.success) {
        throw new AiError(502, 'AI_INVALID_OUTPUT', 'La IA devolvió una respuesta con formato inválido. Intenta de nuevo.');
    }
    return { data: checked.data as z.infer<S>, usage: res.usage, model: res.model, provider: provider.name };
}
