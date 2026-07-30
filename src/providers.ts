/**
 * Local inference provider helpers.
 *
 * Every provider here serves an OpenAI-compatible API on localhost, so pi-bench can
 * discover which model is actually loaded instead of requiring --model on every run.
 */

export interface LocalProviderConfig {
  defaultPort: string;
  /** How the currently-served model is discovered. */
  discovery: "openai-models" | "lemonade-health";
}

export const LOCAL_PROVIDERS: Record<string, LocalProviderConfig> = {
  "llama.cpp": { defaultPort: "8080", discovery: "openai-models" },
  ds4: { defaultPort: "8000", discovery: "openai-models" },
  vllm: { defaultPort: "8000", discovery: "openai-models" },
  lemonade: { defaultPort: "13305", discovery: "lemonade-health" },
};

export function isLocalProvider(provider: string): boolean {
  return provider in LOCAL_PROVIDERS;
}

export function defaultPortFor(provider: string): string | undefined {
  return LOCAL_PROVIDERS[provider]?.defaultPort;
}

export interface DetectedModel {
  id: string;
  /** Context window the server actually loaded the model with, when it reports one. */
  contextWindow?: number;
}

/**
 * Ask a local server which model it is currently serving.
 *
 * llama.cpp / ds4 / vLLM serve exactly one model, so /v1/models is authoritative.
 *
 * Lemonade is different: /v1/models lists the entire installable catalogue
 * (including image, audio and TTS models), so the first entry is meaningless.
 * /api/v1/health reports what is actually resident on the GPU.
 */
export async function detectLoadedModel(provider: string, port: string): Promise<DetectedModel | null> {
  const config = LOCAL_PROVIDERS[provider];
  if (!config) return null;

  if (config.discovery === "lemonade-health") {
    const res = await fetch(`http://localhost:${port}/api/v1/health`);
    const health: any = await res.json();

    const loadedLlms: any[] = Array.isArray(health?.all_models_loaded)
      ? health.all_models_loaded.filter((m: any) => m?.type === "llm" && m?.loaded !== false)
      : [];
    const entry = loadedLlms.find((m: any) => m.model_name === health?.model_loaded) ?? loadedLlms[0];
    const id = entry?.model_name ?? health?.model_loaded;
    if (!id) return null;

    const contextWindow = entry?.recipe_options?.ctx_size ?? entry?.max_context_window;
    return { id, contextWindow: typeof contextWindow === "number" ? contextWindow : undefined };
  }

  const res = await fetch(`http://localhost:${port}/v1/models`);
  const data: any = await res.json();
  const id = data?.data?.[0]?.id;
  return id ? { id } : null;
}
