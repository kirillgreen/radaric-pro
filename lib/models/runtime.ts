// Server-side settings shared by the web app and worker. The browser only
// receives the default model name, never the gateway URL or its key.
import { getModelProvider, OPENAI_COMPATIBLE_PREFIX, resolveModelForStage, type ModelStage } from "./registry"

export function getOpenAICompatibleModelName(): string | undefined {
  return process.env.OPENAI_COMPATIBLE_MODEL?.trim() || undefined
}

export function getOpenAICompatibleBaseURL(): string | undefined {
  const raw = process.env.OPENAI_COMPATIBLE_BASE_URL?.trim()
  if (!raw) return undefined
  try {
    const url = new URL(raw)
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      return undefined
    }
    return url.href.replace(/\/+$/, "")
  } catch {
    return undefined
  }
}

export function resolveRuntimeModelForStage(stage: ModelStage, override?: string | null): string {
  const model = getOpenAICompatibleModelName()
  return resolveModelForStage(stage, override, model ? `${OPENAI_COMPATIBLE_PREFIX}${model}` : undefined)
}

/** Configuration check only; does not probe the endpoint or validate credentials. */
export function getMissingModelSetting(modelId: string, anthropicApiKey?: string | null) {
  switch (getModelProvider(modelId)) {
    case "openai-compatible":
      return getOpenAICompatibleBaseURL() ? null : "OPENAI_COMPATIBLE_BASE_URL"
    case "openrouter":
      return process.env.OPENROUTER_API_KEY ? null : "OPENROUTER_API_KEY"
    case "anthropic":
      return anthropicApiKey || process.env.ANTHROPIC_API_KEY ? null : "ANTHROPIC_API_KEY"
  }
}
