// @vitest-environment node

/**
 * RAD-293 — "AI provider not configured" notice, exercising the REAL
 * model-aware predicate (lib/ai-config): the default filtering model is an
 * OpenRouter model, so an Anthropic-only key must NOT silence the banner.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(async () => ({ user: { id: "u1", role: "ADMIN" } })),
}))

vi.mock("@/lib/db", () => ({
  db: { settings: { findFirst: vi.fn(async () => ({ aiModel: null, aiApiKey: null })) } },
}))

import { db } from "@/lib/db"
import { auth } from "@/lib/auth"
import { AiNotConfiguredNotice } from "@/components/system/ai-not-configured-notice"

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv("ANTHROPIC_API_KEY", "")
  vi.stubEnv("OPENROUTER_API_KEY", "")
  vi.stubEnv("OPENAI_COMPATIBLE_MODEL", "")
  vi.stubEnv("OPENAI_COMPATIBLE_BASE_URL", "")
  vi.mocked(db.settings.findFirst).mockResolvedValue({ aiModel: null, aiApiKey: null } as never)
  vi.mocked(auth).mockResolvedValue({ user: { id: "u1", role: "ADMIN" } } as never)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("AiNotConfiguredNotice", () => {
  it("renders the admin banner naming the key the default model needs", async () => {
    const html = renderToStaticMarkup(await AiNotConfiguredNotice())

    expect(html).toContain("AI filtering is not configured")
    expect(html).toContain("OPENROUTER_API_KEY")
    expect(html).toContain('href="/settings"')
  })

  it("STILL renders with an Anthropic-only key when the filtering model is OpenRouter (the review's trap)", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test")

    const html = renderToStaticMarkup(await AiNotConfiguredNotice())

    expect(html).toContain("AI filtering is not configured")
    expect(html).toContain("OPENROUTER_API_KEY")
  })

  it("renders nothing when the OpenRouter env key exists", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test")
    expect(renderToStaticMarkup(await AiNotConfiguredNotice())).toBe("")
  })

  it("renders nothing for a direct-Anthropic filtering model with a Settings key", async () => {
    vi.mocked(db.settings.findFirst).mockResolvedValue({ aiModel: "claude-sonnet-5", aiApiKey: "sk-ant-global" } as never)
    expect(renderToStaticMarkup(await AiNotConfiguredNotice())).toBe("")
  })

  it("checks the custom filtering default rather than requiring an OpenRouter key", async () => {
    vi.stubEnv("OPENAI_COMPATIBLE_MODEL", "custom-model")
    expect(renderToStaticMarkup(await AiNotConfiguredNotice())).toContain("OPENAI_COMPATIBLE_BASE_URL")

    vi.stubEnv("OPENAI_COMPATIBLE_BASE_URL", "https://gateway.example.com/v1")
    expect(renderToStaticMarkup(await AiNotConfiguredNotice())).toBe("")
  })

  it("gives a non-admin the actionable copy (no dead-end Settings link)", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: "u1", role: "USER" } } as never)

    const html = renderToStaticMarkup(await AiNotConfiguredNotice())

    expect(html).toContain("ask your instance administrator")
    expect(html).not.toContain('href="/settings"')
  })

  it("renders nothing without a session", async () => {
    vi.mocked(auth).mockResolvedValue(null as never)
    expect(renderToStaticMarkup(await AiNotConfiguredNotice())).toBe("")
  })
})
