import { generateObject } from "ai"
import { z } from "zod"
import Parser from "rss-parser"
import { db } from "@/lib/db"
import { createModel } from "@/lib/ai"
import { buildProviderOptions } from "@/lib/models/registry"
import { getMissingModelSetting, resolveRuntimeModelForStage } from "@/lib/models/runtime"
import { detectRSSFeed } from "@/lib/parsers/rss"
import { safeFetch } from "@/lib/url-validation"

/**
 * LLM source discovery for a tracked question (Slice 3).
 *
 * Given the question's NL query, the model suggests reputable publications likely
 * to cover it; each suggestion is then VALIDATED into a real, reachable RSS feed
 * (we only return what resolves — no hallucinated/dead URLs reach the user). The
 * caller adds the chosen feeds via the canonical POST /api/feeds; Slice-2 routing
 * then pulls their matching material into the question automatically.
 *
 * RSS-only by design: a validated feed is the one source type we can both verify
 * up front and add cleanly. Twitter/Telegram discovery is a later enhancement.
 */

// LLM is asked for at most this many; the schema cap matches so a stray extra
// suggestion can't balloon the validation fan-out.
const MAX_SUGGESTIONS = 8
const DISCOVERY_TIMEOUT_MS = 30_000 // the single generateObject call
const VALIDATE_BATCH = 4 // sources validated concurrently per batch
const FEED_FETCH_MS = 8_000 // hard cap per feed fetch (rss-parser alone defaults to 60s)

const SUGGEST_SCHEMA = z.object({
  sources: z
    .array(
      z.object({
        name: z.string().describe("The publication / site name"),
        url: z.string().describe("The site homepage URL (https://…) — its RSS is resolved automatically"),
        reason: z.string().describe("One sentence on why this source is relevant to the question"),
      })
    )
    .max(MAX_SUGGESTIONS),
})
// Worst-case wall time ≈ DISCOVERY_TIMEOUT_MS + ceil(MAX_SUGGESTIONS/VALIDATE_BATCH) ×
// (FEED_FETCH_MS + detectRSSFeed 10s + FEED_FETCH_MS) — bounded, runs with a spinner.

export class AiNotConfiguredError extends Error {
  constructor() {
    super("AI is not configured")
    this.name = "AiNotConfiguredError"
  }
}

export type DiscoveredSource = { name: string; feedUrl: string; reason: string; alreadyAdded: boolean }
export type DiscoveryResult = { sources: DiscoveredSource[]; suggested: number }

const feedParser = new Parser()

/** Fetch + parse a URL as an RSS/Atom feed — SSRF-safe (redirect hops validated) and hard-bounded. */
async function validateFeed(url: string): Promise<{ title: string } | null> {
  try {
    const res = await safeFetch(url, {
      timeoutMs: FEED_FETCH_MS,
      headers: { "user-agent": "Radaric/1.0 (+source discovery)" },
    })
    if (!res || !res.ok) return null
    const xml = await res.text()
    const feed = await feedParser.parseString(xml)
    return { title: feed.title || new URL(url).hostname }
  } catch {
    return null
  }
}

/** Resolve a site/feed URL to a VALIDATED RSS feed URL (+ title), or null. */
async function resolveRssFeed(url: string): Promise<{ feedUrl: string; name: string } | null> {
  // 1. Is the URL itself a feed?
  const direct = await validateFeed(url)
  if (direct) return { feedUrl: url, name: direct.title }
  // 2. Does the site advertise a feed? (detectRSSFeed is isAllowedUrl-guarded + 10s)
  const detected = await detectRSSFeed(url)
  if (!detected) return null
  const validated = await validateFeed(detected)
  return validated ? { feedUrl: detected, name: validated.title } : null
}

export async function discoverSourcesForTopic(query: string, userId: string): Promise<DiscoveryResult> {
  const s = await db.settings.findFirst({
    select: { id: true, aiModel: true, aiApiKey: true, aiTemperature: true, discoveryModel: true },
  })
  const settings = s
    ? { id: s.id, aiModel: s.aiModel ?? "", aiApiKey: s.aiApiKey ?? "", aiTemperature: s.aiTemperature ?? 0.3 }
    : null
  // discoveryModel is this stage's own setting; null follows the stage default.
  // It used to borrow Settings.aiModel — the FILTERING model, tuned for throughput
  // on hundreds of short items a day, which is the wrong tier for this job.
  const modelId = resolveRuntimeModelForStage("discovery", s?.discoveryModel)
  // Model-aware: the resolved discovery model needs ITS provider's credential
  // (RAD-293 — the same predicate the first-run banner uses, so they can't drift).
  if (getMissingModelSetting(modelId, s?.aiApiKey)) {
    throw new AiNotConfiguredError()
  }
  const model = await createModel(settings, { modelId })
  const providerOptions = buildProviderOptions(modelId)

  const prompt = `A user is tracking this question and wants reputable sources that regularly publish about it.

QUESTION: "${query}"

Suggest up to ${MAX_SUGGESTIONS} real, currently-active, authoritative sources (news outlets, trade publications, expert blogs, official bodies) that frequently cover this exact topic. Rules:
- Prefer primary/authoritative sources over aggregators; avoid paywalled-only or defunct sites.
- Give each source's real homepage URL as https://… — its RSS feed is resolved automatically, so a plain site URL is fine.
- Only suggest sources you are confident actually exist and publish regularly on this topic. Quality over quantity — a few strong sources beat many weak ones.
- reason: one concrete sentence tying the source to the question.`

  const result = await generateObject({
    model,
    schema: SUGGEST_SCHEMA,
    prompt,
    temperature: 0.4,
    abortSignal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    maxRetries: 1,
    ...(providerOptions ? { providerOptions } : {}),
  })

  const suggestions = result.object.sources.slice(0, MAX_SUGGESTIONS)

  // Validate → resolve to real RSS feeds, batched, deduped.
  const resolved: Array<{ name: string; feedUrl: string; reason: string }> = []
  const seen = new Set<string>()
  for (let i = 0; i < suggestions.length; i += VALIDATE_BATCH) {
    const batch = suggestions.slice(i, i + VALIDATE_BATCH)
    const results = await Promise.all(
      batch.map(async (sug) => {
        if (!/^https?:\/\//i.test(sug.url.trim())) return null
        const r = await resolveRssFeed(sug.url.trim())
        return r ? { name: r.name || sug.name, feedUrl: r.feedUrl, reason: sug.reason } : null
      })
    )
    for (const r of results) {
      if (!r || seen.has(r.feedUrl)) continue
      seen.add(r.feedUrl)
      resolved.push(r)
    }
  }

  if (resolved.length === 0) return { sources: [], suggested: suggestions.length }

  // Flag the ones the user already has so the UI can disable them.
  const existing = await db.feed.findMany({
    where: { userId, url: { in: resolved.map((r) => r.feedUrl) } },
    select: { url: true },
  })
  const existingUrls = new Set(existing.map((f) => f.url))

  return {
    sources: resolved.map((r) => ({ ...r, alreadyAdded: existingUrls.has(r.feedUrl) })),
    suggested: suggestions.length,
  }
}
