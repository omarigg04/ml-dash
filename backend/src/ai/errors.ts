export class AiError extends Error {
    constructor(public status: number, public code: string, message: string) { super(message); }
}

export interface AiUsage { input_tokens: number; output_tokens: number; }

/** Opciones por llamada. `model` y `effort` solo los usa el proveedor Anthropic (opcional y de pago); Gemini los ignora. */
export interface CallOptions { model?: string; effort?: 'low' | 'medium' | 'high'; maxTokens?: number; }

/** Lo que cada proveedor devuelve a la capa común, que valida con zod y las reglas. */
export interface ProviderResult {
    /** Salida ya parseada o JSON como texto; la capa común la valida siempre con el esquema zod. */
    candidate: unknown;
    stop: 'ok' | 'refusal' | 'truncated';
    usage: AiUsage;
    model: string;
}

export interface ProviderRequest {
    label: string;
    system: string;
    user: string;
    /** Esquema zod original (lo usa Anthropic con zodOutputFormat). */
    schema: any;
    /** El mismo esquema como JSON Schema (lo usa Gemini). */
    jsonSchema: any;
    opts: CallOptions;
    signal: AbortSignal;
}

export interface AiProvider {
    name: 'gemini' | 'anthropic';
    configured(): boolean;
    generate(req: ProviderRequest): Promise<ProviderResult>;
}
