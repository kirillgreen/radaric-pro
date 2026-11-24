import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { generateObject } from "ai"
import { z } from "zod"
import { extractFeedsWithLLM } from "@/lib/feed-extraction"
import { createModelInstance } from "@/lib/models/provider"
import { buildProviderOptions, requiresAnthropicKey, STAGE_DEFAULTS, type ModelStage } from "@/lib/models/registry"
import { resolveRuntimeModelForStage } from "@/lib/models/runtime"

function mockCompletion(content: unknown) {
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({
    choices: [{ message: { role: "assistant", content: JSON.stringify(content) }, finish_reason: "stop" }],
  }))
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

beforeEach(() => {
  vi.stubEnv("OPENAI_COMPATIBLE_BASE_URL", "https://gateway.example.com/api/v1/")
  vi.stubEnv("OPENAI_COMPATIBLE_MODEL", "my-org/custom-model")
  vi.stubEnv("OPENAI_COMPATIBLE_API_KEY", "")
  vi.stubEnv("OPENROUTER_API_KEY", "")
  vi.stubEnv("ANTHROPIC_API_KEY", "")
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe("custom OpenAI-compatible gateway", () => {
  it("uses the environment model for every stage without replacing a saved model", () => {
    for (const stage of Object.keys(STAGE_DEFAULTS) as ModelStage[]) {
      const model = resolveRuntimeModelForStage(stage)
      expect(model).toBe("openai-compatible/my-org/custom-model")
      expect(requiresAnthropicKey(model)).toBe(false)
      expect(buildProviderOptions(model)).toBeUndefined()
    }
    expect(resolveRuntimeModelForStage("filtering", "claude-sonnet-4-6")).toBe("claude-sonnet-4-6")
    expect(resolveRuntimeModelForStage("synthesis", "google/gemini-3.8-flash")).toBe("google/gemini-3.8-flash")
    vi.stubEnv("OPENAI_COMPATIBLE_MODEL", "")
    expect(resolveRuntimeModelForStage("filtering")).toBe(STAGE_DEFAULTS.filtering)
  })

  it("sends a JSON Schema request with the exact model and only the gateway key", async () => {
    vi.stubEnv("OPENAI_COMPATIBLE_API_KEY", "gateway-test-key")
    vi.stubEnv("OPENROUTER_API_KEY", "openrouter-test-key")
    const fetchMock = mockCompletion({ relevant: true })
    const model = await createModelInstance(resolveRuntimeModelForStage("filtering"), {
      anthropicApiKey: "anthropic-test-key",
    })

    const result = await generateObject({
      model,
      schema: z.object({ relevant: z.boolean() }),
      prompt: "Is this article relevant?",
      maxRetries: 0,
    })

    expect(result.object).toEqual({ relevant: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe("https://gateway.example.com/api/v1/chat/completions")
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer gateway-test-key")
    const body = JSON.parse(String(init?.body))
    expect(body).toMatchObject({
      model: "my-org/custom-model",
      response_format: {
        type: "json_schema",
        json_schema: { schema: { properties: { relevant: { type: "boolean" } }, required: ["relevant"] } },
      },
    })
    expect(body).not.toHaveProperty("provider")
  })

  it("uses the gateway for onboarding extraction even without an OpenRouter or gateway key", async () => {
    vi.stubEnv("OPENAI_API_KEY", "unrelated-archive-test-key")
    const fetchMock = mockCompletion({ feeds: [{ url: "https://t.me/example", name: "Example", type: "TELEGRAM" }] })

    await expect(extractFeedsWithLLM("Check out the Example channel")).resolves.toEqual([
      { url: "https://t.me/example", name: "Example", type: "TELEGRAM", status: "found" },
    ])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).has("authorization")).toBe(false)
  })

  it("does not silently send requests to another provider when the gateway URL is invalid", async () => {
    vi.stubEnv("OPENAI_COMPATIBLE_BASE_URL", "file:///not-a-gateway")
    vi.stubEnv("OPENROUTER_API_KEY", "openrouter-test-key")
    const fetchMock = mockCompletion({})

    await expect(createModelInstance(resolveRuntimeModelForStage("filtering"))).rejects.toThrow("OPENAI_COMPATIBLE_BASE_URL")
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
