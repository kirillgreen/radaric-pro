// ---------------------------------------------------------------------------
// The one place a provider client is constructed. Server-only.
//
// Split from registry.ts because that module is imported by a client
// component (settings-form.tsx) and must stay free of provider SDKs; this one
// pulls @ai-sdk/openai and @ai-sdk/anthropic.
//
// Before this file there were six independent construction sites — lib/ai.ts,
// pipeline-deps.ts (×3), worker.ts and feed-extraction.ts — each with its own
// copy of the "slash means OpenRouter" branch and its own credential handling.
// Every cross-cutting change (reasoning effort, provider data-collection policy,
// a retired-id guard) was therefore a six-site change, and a six-site change
// applied to five sites is how worker.ts ended up the one path missing the JSON
// fence-stripper pipeline-deps.ts had from the start.
// ---------------------------------------------------------------------------

import type { LanguageModel } from "ai"
import { getModelProvider, OPENAI_COMPATIBLE_PREFIX } from "./registry"
import { getOpenAICompatibleBaseURL } from "./runtime"

export interface CreateModelOptions {
  /**
   * Direct-Anthropic credential (Settings.aiApiKey). Consulted only for
   * direct-Anthropic ids; ANTHROPIC_API_KEY is the fallback.
   */
  anthropicApiKey?: string | null
}

/**
 * Providers are imported lazily so a route touching only OpenRouter models does
 * not pull @ai-sdk/anthropic into its bundle, and vice versa — every one of the
 * six previous sites did this, and the behaviour is preserved.
 */
export async function createModelInstance(
  modelId: string,
  options: CreateModelOptions = {}
): Promise<LanguageModel> {
  const provider = getModelProvider(modelId)
  if (provider === "openai-compatible") {
    const baseURL = getOpenAICompatibleBaseURL()
    if (!baseURL) {
      throw new Error("OPENAI_COMPATIBLE_BASE_URL must be an HTTP(S) base URL without credentials, query, or fragment")
    }
    const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible")
    return createOpenAICompatible({
      name: provider,
      baseURL,
      apiKey: process.env.OPENAI_COMPATIBLE_API_KEY?.trim() || undefined,
      supportsStructuredOutputs: true,
    }).chatModel(modelId.slice(OPENAI_COMPATIBLE_PREFIX.length))
  }

  if (provider === "openrouter") {
    const apiKey = process.env.OPENROUTER_API_KEY
    if (!apiKey) {
      throw new Error(
        `OPENROUTER_API_KEY environment variable is not set (needed for model: ${modelId})`
      )
    }
    const { createOpenAI } = await import("@ai-sdk/openai")
    const openrouter = createOpenAI({
      apiKey,
      baseURL: "https://openrouter.ai/api/v1",
      fetch: denyDataCollection,
    })
    return openrouter.chat(modelId) as LanguageModel
  }

  const apiKey = options.anthropicApiKey || process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    throw new Error(
      `ANTHROPIC_API_KEY is not configured, neither in settings nor env (needed for model: ${modelId})`
    )
  }
  const { createAnthropic } = await import("@ai-sdk/anthropic")
  return createAnthropic({ apiKey })(modelId) as LanguageModel
}

// ---------------------------------------------------------------------------
// Provider routing
// ---------------------------------------------------------------------------

/**
 * Refuse providers that train on, or retain, request content.
 *
 * `provider: { data_collection: "deny" }` is an OpenRouter body field, and
 * @ai-sdk/openai builds its request body from a CLOSED set of keys — there is no
 * extraBody escape hatch, and an unknown key in providerOptions.openai is dropped
 * by the SDK's zod parse. A fetch middleware is the supported seam (the provider
 * option is documented as "use it as a middleware to intercept requests"), and it
 * is the only one that reaches the wire.
 *
 * This matters because several catalogue entries are served by third parties —
 * GLM by GMICloud / Novita / DeepInfra, DeepSeek likewise — so the request body
 * is where the retention policy has to be stated. OpenRouter routes around any
 * provider that will not accept the constraint.
 */
const denyDataCollection: typeof fetch = async (input, init) => {
  if (typeof init?.body !== "string") return fetch(input, init)

  let body: unknown
  try {
    body = JSON.parse(init.body)
  } catch {
    // Not JSON we can extend — send it untouched rather than corrupting it.
    return fetch(input, init)
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return fetch(input, init)
  }

  const withPolicy = { ...(body as Record<string, unknown>), provider: { data_collection: "deny" } }
  return fetch(input, { ...init, body: JSON.stringify(withPolicy) })
}
