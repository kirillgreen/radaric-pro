// ---------------------------------------------------------------------------
// Model registry — the single place that knows which models exist, which model
// each stage runs on, and how to construct a model instance.
//
// Before this module there were six independent model-construction sites
// (lib/ai.ts, pipeline-deps.ts ×3, worker.ts, feed-extraction.ts), each with its
// own copy of the "does the id contain a slash → OpenRouter, else Anthropic"
// branch and its own credential handling. Every cross-cutting change — reasoning
// effort, provider data-collection policy, a retired-id guard — was therefore a
// six-site change, and a six-site change applied to five sites is exactly how
// worker.ts ended up as the one path missing the JSON fence-stripper that
// pipeline-deps.ts had from the start.
//
// One catalogue, one resolver, one constructor.
//
// This half — the catalogue, the stage map and the resolver — is CLIENT-SAFE and
// deliberately imports no provider SDK: components/settings/settings-form.tsx is
// a client component and renders these lists. Construction lives next door in
// lib/models/provider.ts, which is server-only.
// ---------------------------------------------------------------------------

export interface ModelOption {
  id: string
  label: string
  /**
   * Artificial Analysis Intelligence Index, as published by OpenRouter's own
   * /models endpoint (`benchmarks.artificial_analysis.intelligence_index`).
   *
   * This is the intelligence axis the defaults below are ranked on. It is NOT
   * LMArena Elo: OpenRouter carries no LMArena score, and its one true Elo field
   * (`design_arena`) only covers coding/design arenas — website, gamedev,
   * dataviz, svg — which say nothing about judging editorial relevance.
   * Undefined for models Artificial Analysis has not scored.
   */
  score?: number
  /** USD per 1M input tokens, list price at the time of the survey. */
  priceIn?: number
  /** USD per 1M output tokens. Reasoning tokens bill at this rate. */
  priceOut?: number
  /**
   * Whether the provider accepts a `reasoning_effort` parameter.
   *
   * Read off `supported_parameters` on OpenRouter's /models endpoint, not
   * guessed: sending an effort to a model that does not take one is a wasted
   * field at best and a 400 at worst, so buildProviderOptions() gates on this.
   */
  supportsReasoningEffort?: boolean
}

// ---------------------------------------------------------------------------
// Catalogue
//
// Prices and scores surveyed 2026-09-09 against https://openrouter.ai/api/v1/models;
// entries added on 2026-11-16 carry that day's figures.
// They exist to inform the Settings dropdown and to document why the defaults are
// what they are; nothing routes on them, so drift costs a stale label, not a bug.
// ---------------------------------------------------------------------------

/** Models reached directly through the Anthropic API (settings.aiApiKey). */
export const ANTHROPIC_MODELS: ModelOption[] = [
  { id: "claude-opus-5", label: "Claude Opus 5", score: 50.7, priceIn: 5, priceOut: 25, supportsReasoningEffort: true },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5", score: 38.4, priceIn: 2, priceOut: 10, supportsReasoningEffort: true },
  { id: "claude-opus-4-6", label: "Claude Opus 4.6", priceIn: 5, priceOut: 25, supportsReasoningEffort: true },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", score: 30.5, priceIn: 3, priceOut: 15, supportsReasoningEffort: true },
  { id: "claude-sonnet-4-5-20250929", label: "Claude Sonnet 4.5", score: 21.2, priceIn: 3, priceOut: 15 },
  // NB: the undated "claude-haiku-4-5" is NOT served on this account — the dated
  // id is the only working Haiku, contrary to the usual no-date-suffix rule.
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", score: 17.6, priceIn: 1, priceOut: 5 },
]

/** Models reached through OpenRouter. */
export const OPENROUTER_MODELS: ModelOption[] = [
  // --- The score-per-cent leaders (see STAGE_DEFAULTS) ---
  { id: "z-ai/glm-5.3-flash", label: "GLM-5.3 Flash", score: 41.9, priceIn: 0.07, priceOut: 0.25, supportsReasoningEffort: true },
  { id: "deepseek/deepseek-v4-flash-0731", label: "DeepSeek V4 Flash", score: 34.5, priceIn: 0.07, priceOut: 0.18, supportsReasoningEffort: true },
  { id: "deepseek/deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash", score: 39.5, priceIn: 0.15, priceOut: 0.6, supportsReasoningEffort: true },
  { id: "deepseek/deepseek-v4.1-flash-1017", label: "DeepSeek V4.1 Flash 1017", score: 28.6, priceIn: 0.15, priceOut: 0.6, supportsReasoningEffort: true },
  { id: "openai/gpt-5.6-luna", label: "GPT-5.6 Luna", score: 37.5, priceIn: 0.2, priceOut: 1.2, supportsReasoningEffort: true },
  { id: "anthropic/claude-haiku-5.5", label: "Claude Haiku 5.5 (via OpenRouter)", score: 36.5, priceIn: 0.1, priceOut: 0.5, supportsReasoningEffort: true },
  { id: "openai/gpt-6-luna", label: "GPT-6 Luna", score: 27.9, priceIn: 0.1, priceOut: 0.5, supportsReasoningEffort: true },
  // --- Mid tier ---
  { id: "deepseek/deepseek-v4-pro-0813", label: "DeepSeek V4 Pro", score: 36.3, priceIn: 0.58, priceOut: 1.74, supportsReasoningEffort: true },
  { id: "qwen/qwen3.8-27b", label: "Qwen 3.8 27B", score: 33.9, priceIn: 0.42, priceOut: 3, supportsReasoningEffort: true },
  { id: "google/gemini-3.8-flash", label: "Gemini 3.8 Flash", score: 41.2, priceIn: 0.75, priceOut: 3.75, supportsReasoningEffort: true },
  { id: "google/gemini-3.7-flash", label: "Gemini 3.7 Flash", score: 39.4, priceIn: 0.75, priceOut: 3.75, supportsReasoningEffort: true },
  { id: "google/gemini-3.5-flash", label: "Gemini 3.5 Flash", score: 33, priceIn: 1.5, priceOut: 9, supportsReasoningEffort: true },
  { id: "google/gemini-3.5-flash-lite", label: "Gemini 3.5 Flash Lite", score: 22.7, priceIn: 0.3, priceOut: 2.5, supportsReasoningEffort: true },
  { id: "google/gemini-3.1-flash-lite", label: "Gemini 3.1 Flash Lite", priceIn: 0.25, priceOut: 1.5, supportsReasoningEffort: true },
  { id: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro", score: 16.7, priceIn: 1.25, priceOut: 10 },
  { id: "z-ai/glm-4.7-flash", label: "GLM-4.7 Flash", priceIn: 0.06, priceOut: 0.4 },
  { id: "z-ai/glm-4.7", label: "GLM-4.7", priceIn: 0.4, priceOut: 1.75 },
  { id: "qwen/qwen3.5-9b", label: "Qwen 3.5 9B", priceIn: 0.1, priceOut: 0.15 },
  { id: "qwen/qwen3.5-27b", label: "Qwen 3.5 27B", priceIn: 0.2, priceOut: 1.56 },
  { id: "qwen/qwen3.5-397b-a17b", label: "Qwen 3.5 397B MoE", score: 19.1, priceIn: 0.55, priceOut: 3.5 },
  // --- Frontier: better absolute intelligence, far worse score-per-cent ---
  { id: "z-ai/glm-5.3", label: "GLM-5.3", score: 44.9, priceIn: 1.4, priceOut: 4.4, supportsReasoningEffort: true },
  { id: "x-ai/grok-4.6", label: "Grok 4.6", score: 44.4, priceIn: 2, priceOut: 6, supportsReasoningEffort: true },
  { id: "qwen/qwen3.8-max-0902", label: "Qwen 3.8 Max", score: 40.3, priceIn: 2, priceOut: 6, supportsReasoningEffort: true },
  { id: "openai/gpt-5.6-sol", label: "GPT-5.6 Sol", score: 47.1, priceIn: 2, priceOut: 10, supportsReasoningEffort: true },
  { id: "openai/gpt-6.1-sol", label: "GPT-6.1 Sol", score: 54.6, priceIn: 2, priceOut: 10, supportsReasoningEffort: true },
  { id: "moonshotai/kimi-k3", label: "Kimi K3", score: 43.8, priceIn: 3, priceOut: 15, supportsReasoningEffort: true },
  { id: "anthropic/claude-opus-5.5", label: "Claude Opus 5.5 (via OpenRouter)", score: 59.1, priceIn: 4, priceOut: 20, supportsReasoningEffort: true },
  { id: "anthropic/claude-sonnet-5.5", label: "Claude Sonnet 5.5 (via OpenRouter)", score: 54.5, priceIn: 2, priceOut: 10, supportsReasoningEffort: true },
  { id: "anthropic/claude-opus-5", label: "Claude Opus 5 (via OpenRouter)", score: 50.7, priceIn: 5, priceOut: 25, supportsReasoningEffort: true },
  { id: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5 (via OpenRouter)", score: 38.4, priceIn: 2, priceOut: 10, supportsReasoningEffort: true },
  { id: "anthropic/claude-sonnet-4.6", label: "Claude Sonnet 4.6 (via OpenRouter)", score: 30.5, priceIn: 3, priceOut: 15, supportsReasoningEffort: true },
  { id: "anthropic/claude-haiku-4.5", label: "Claude Haiku 4.5 (via OpenRouter)", score: 17.6, priceIn: 1, priceOut: 5 },
  { id: "anthropic/claude-fable-5.1", label: "Claude Fable 5.1 (via OpenRouter)", score: 53.4, priceIn: 10, priceOut: 50, supportsReasoningEffort: true },
  { id: "anthropic/claude-fable-5.2", label: "Claude Fable 5.2 (via OpenRouter)", score: 64.6, priceIn: 8, priceOut: 40, supportsReasoningEffort: true },
]

const MODELS_BY_ID: ReadonlyMap<string, ModelOption> = new Map(
  [...ANTHROPIC_MODELS, ...OPENROUTER_MODELS].map((m) => [m.id, m])
)

export function isKnownModel(modelId: string): boolean {
  return MODELS_BY_ID.has(modelId)
}

/** Catalogue entry for an id, or undefined when the id is not offered. */
export function getModelOption(modelId: string): ModelOption | undefined {
  return MODELS_BY_ID.get(modelId)
}

export const OPENAI_COMPATIBLE_PREFIX = "openai-compatible/"

/** Gateway defaults carry an explicit prefix; built-in IDs keep their existing routing. */
export function getModelProvider(modelId: string): "openai-compatible" | "openrouter" | "anthropic" {
  if (modelId.startsWith(OPENAI_COMPATIBLE_PREFIX)) return "openai-compatible"
  return modelId.includes("/") ? "openrouter" : "anthropic"
}

export function isOpenRouterModel(modelId: string): boolean {
  return getModelProvider(modelId) === "openrouter"
}

/** Only direct-Anthropic ids can use the key stored in Settings. */
export function requiresAnthropicKey(modelId: string): boolean {
  return getModelProvider(modelId) === "anthropic"
}

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

/**
 * Every place in the app that reaches a model, and what it runs by default.
 *
 * All seven default to the same model, and that is the finding rather than a
 * shortcut. Ranked by intelligence-per-cent — Artificial Analysis Intelligence
 * Index divided by a blended token price weighted 10 input : 1 output, which is
 * roughly Radaric's shape (a long article in, a small JSON verdict out) —
 * z-ai/glm-5.3-flash scores 4.61 against 4.57 for the runner-up and 0.40 for the
 * best of what we ran before. It is not a cheap-but-worse trade: at AAI 41.9 it
 * also beats every previous default on raw capability, including
 * claude-sonnet-4.6 (30.5) at ~1/40th the blended price. 1.31M context, 131k max
 * output, temperature and reasoning_effort both supported.
 *
 * The per-stage columns therefore exist for divergence we have not needed yet,
 * not for divergence that already exists. The two worth watching are storyWriter
 * and synthesis: they emit prose a human reads, and an intelligence composite is
 * a poor proxy for writing. If those read flat, escalate them in Settings —
 * z-ai/glm-5.3 (AAI 44.9) or anthropic/claude-fable-5.1 (53.4) are the rungs up.
 *
 * `filtering` is the product's core job and the one stage whose model is stored
 * in Settings.aiModel; synthesis and discovery have their own columns.
 */
export const STAGE_DEFAULTS = {
  /** lib/ai.ts — material filtering, tracked-question routing, interest parser. */
  filtering: "z-ai/glm-5.3-flash",
  /** lib/feed-extraction.ts — onboarding feed extraction. */
  extraction: "z-ai/glm-5.3-flash",
  /** Story Aggregator — InboxItem story writing. */
  storyWriter: "z-ai/glm-5.3-flash",
  /** Story Aggregator — InboxItem story matching. */
  storyMatcher: "z-ai/glm-5.3-flash",
  /** Story Aggregator — the Material story pipeline (matching and writing). */
  materialStory: "z-ai/glm-5.3-flash",
  /** lib/saved/synthesis.ts — Knowledge Base living answers. */
  synthesis: "z-ai/glm-5.3-flash",
  /** lib/saved/discovery.ts — source discovery for a tracked question. */
  discovery: "z-ai/glm-5.3-flash",
} as const

export type ModelStage = keyof typeof STAGE_DEFAULTS

/** Treat empty string as "no override", the long-standing settings contract. */
function normalize(value: string | null | undefined): string | null {
  if (!value || value.trim() === "") return null
  return value
}

/**
 * Write-time validation for a model id arriving from a request body.
 *
 * Returns null — "no override" — for anything not in the catalogue, so a bad or
 * hostile value never reaches the column. This is deliberately stricter than
 * resolveModelForStage(), which TOLERATES an unknown stored value at read time so
 * the UI can still show the user that their saved choice is gone. Reject on the
 * way in, tolerate on the way out.
 */
export function sanitizeModelId(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null
  return isKnownModel(value) ? value : null
}

/** Write-time validation for a reasoning-effort value from a request body. */
export function sanitizeReasoningEffort(value: unknown): string | null {
  if (typeof value !== "string") return null
  return resolveReasoningEffort(value)
}

/**
 * Resolve the model for a stage, dropping a stored override that names a model
 * we no longer offer.
 *
 * Retired ids outlive the dropdown: they stay in `settings` / `user_settings`
 * long after the catalogue entry is removed, and a provider answers a retired id
 * with a hard error rather than a fallback. One account really did hold
 * `storyMatcherModel = "google/gemini-2.5-flash-lite"` (shutdown 2026-10-16).
 *
 * The stored value is deliberately NOT rewritten — settings still reads it back,
 * so the UI can tell the user their choice is gone instead of silently swapping
 * it underneath them.
 */
export function resolveModelForStage(
  stage: ModelStage,
  override?: string | null,
  defaultModel: string = STAGE_DEFAULTS[stage]
): string {
  const value = normalize(override)
  if (value === null) return defaultModel
  if (isKnownModel(value)) return value
  console.warn(
    `[ModelRegistry] ${stage} override "${value}" is no longer an offered model — falling back to ${defaultModel}`
  )
  return defaultModel
}

// ---------------------------------------------------------------------------
// Reasoning effort
// ---------------------------------------------------------------------------

/**
 * The values @ai-sdk/openai will accept — it parses providerOptions.openai with
 * a zod enum, so anything outside this set is silently dropped rather than sent.
 *
 * Stored as TEXT rather than a Prisma enum: providers keep adding values, and an
 * enum would make each new one an `ALTER TYPE ... ADD VALUE` migration, which
 * this repo requires in a file of its own.
 */
export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]

const REASONING_EFFORT_SET: ReadonlySet<string> = new Set(REASONING_EFFORTS)

/**
 * How hard every stage thinks unless Settings says otherwise.
 *
 * "high", not "xhigh": the SDK's enum accepts xhigh, but it is documented as an
 * OpenAI GPT-5.1-Codex-Max value, and no model in the catalogue advertises it —
 * an unrecognised effort is dropped by OpenRouter, which would quietly leave the
 * stage at the provider's own default instead of the maximum. "high" is the
 * highest setting that every reasoning model here actually honours.
 *
 * Affordable because reasoning tokens bill at the OUTPUT rate, and the default
 * model's output rate is $0.25/1M. On the previous default (claude-sonnet-4.6,
 * $15/1M out) this setting would have been the expensive part of the bill.
 */
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "high"

/**
 * Normalise a stored effort value, or null when nothing valid is stored.
 *
 * Null means "no explicit choice" and lets DEFAULT_REASONING_EFFORT apply; it is
 * not the same as the explicit "none", which asks the model to skip reasoning.
 */
export function resolveReasoningEffort(value?: string | null): ReasoningEffort | null {
  if (!value || value.trim() === "") return null
  const normalized = value.trim().toLowerCase()
  if (REASONING_EFFORT_SET.has(normalized)) return normalized as ReasoningEffort
  console.warn(
    `[ModelRegistry] reasoning effort "${value}" is not one of ${REASONING_EFFORTS.join("|")} — using the default`
  )
  return null
}

/**
 * Per-request provider options for a model, or undefined when there is nothing
 * to send.
 *
 * Scoped to OpenRouter ids on purpose: the key is `openai`, and handing an
 * `openai`-namespaced block to createAnthropic is at best ignored and at worst a
 * 400. `reasoningEffort` is camelCase because that is what the SDK's zod schema
 * expects — the snake_case `reasoning_effort` of the OpenAI wire format is
 * produced by the SDK itself and is dropped if you pass it in.
 *
 * Gated on the catalogue's supportsReasoningEffort flag: a model that does not
 * take the parameter (Gemini 2.5 Pro, GLM-4.7, Qwen 3.5, Claude Haiku 4.5) gets
 * a request with no effort field at all, exactly as before this setting existed.
 * An id outside the catalogue gets none either — unknown capability, send nothing.
 */
export function buildProviderOptions(
  modelId: string,
  options: { reasoningEffort?: ReasoningEffort | null } = {}
): { openai: { reasoningEffort: ReasoningEffort } } | undefined {
  if (!isOpenRouterModel(modelId)) return undefined
  if (!getModelOption(modelId)?.supportsReasoningEffort) return undefined
  return { openai: { reasoningEffort: options.reasoningEffort ?? DEFAULT_REASONING_EFFORT } }
}
