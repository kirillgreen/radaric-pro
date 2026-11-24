import { generateObject } from "ai"
import { z } from "zod"
import type { ExtractedFeed } from "@/lib/onboarding-types"
import { resolveBrandUrl } from "@/lib/feed-flavor"
import { buildProviderOptions } from "@/lib/models/registry"
import { createModelInstance } from "@/lib/models/provider"
import { getMissingModelSetting, resolveRuntimeModelForStage } from "@/lib/models/runtime"

/**
 * Wall-clock cap for the one extraction call.
 *
 * It runs synchronously inside onboarding with the user watching a spinner, and
 * it reasons at the registry's default effort, so it needs a bound: without one
 * a stalled provider hangs the step indefinitely. On timeout the catch below
 * falls back to extractFeedsFromLines(), which is degraded but not broken —
 * the same silent degradation that hid a dead model id for three months
 * (RAD-307), so a timeout here is logged, not swallowed quietly.
 */
const EXTRACTION_TIMEOUT_MS = 45_000

export const extractionSchema = z.object({
  feeds: z.array(z.object({
    url: z.string().nullable(),
    name: z.string(),
    type: z.enum(["RSS", "TELEGRAM", "TWITTER", "YOUTUBE", "WEBSITE"]),
  })),
})

// Any youtube.com channel-ish or video URL, youtu.be short links, and the
// channel feed-XML form (classified as YOUTUBE, not RSS, so it gets transcripts)
const YOUTUBE_URL_RE = /youtube\.com\/(?:@|channel\/|c\/|user\/|watch\?|shorts\/|live\/|feeds\/videos\.xml)|youtu\.be\//i

export function resolveStatus(feed: ExtractedFeed): ExtractedFeed {
  // Telegram and Twitter are immediately "found" — no RSS discovery needed
  if (feed.type === "TELEGRAM") {
    const name = feed.name || feed.url?.replace("https://t.me/", "") || "channel"
    return { ...feed, url: feed.url || `https://t.me/${name}`, status: "found" }
  }
  if (feed.type === "TWITTER") {
    return { ...feed, status: "found" }
  }
  if (feed.type === "RSS") {
    return { ...feed, status: "found" }
  }
  // YouTube inputs are "found" as-is — canonicalization to /channel/UC… is a
  // network step that happens at save (save-feeds / POST /api/feeds)
  if (feed.type === "YOUTUBE") {
    const handle = feed.url?.match(/@([A-Za-z0-9._-]{3,30})/)?.[1]
    const hostname = (() => {
      try { return feed.url ? new URL(feed.url).hostname.replace("www.", "") : null } catch { return null }
    })()
    const name = !feed.name || feed.name === hostname
      ? handle ? `@${handle}` : feed.name || "YouTube channel"
      : feed.name
    return { ...feed, name, status: "found" }
  }
  // Branded platforms (Substack, Bluesky, GitHub, Product Hunt, arXiv) resolve
  // to a known feed URL without discovery — their pages are often SPA shells
  // the <link rel=alternate> probe can't read (RAD-268)
  if (feed.type === "WEBSITE" && feed.url) {
    const brand = resolveBrandUrl(feed.url)
    if (brand) {
      const hostname = (() => {
        try { return new URL(feed.url).hostname.replace("www.", "") } catch { return null }
      })()
      return {
        ...feed,
        type: "RSS",
        status: "found",
        feedUrl: brand.url,
        name: !feed.name || feed.name === hostname ? brand.name ?? feed.name : feed.name,
      }
    }
  }
  // WEBSITE needs RSS discovery
  return { ...feed, status: "pending" }
}

export async function extractFeedsWithLLM(text: string): Promise<ExtractedFeed[]> {
  const modelId = resolveRuntimeModelForStage("extraction")
  if (getMissingModelSetting(modelId)) return extractFeedsFromLines(text)
  const providerOptions = buildProviderOptions(modelId)

  try {
    const { object } = await generateObject({
      model: await createModelInstance(modelId),
      schema: extractionSchema,
      prompt: `Extract all content feed references from this text. For each, return url (or null), name, type.

Rules:
- Telegram channels (t.me/xxx, @xxx if Telegram context, or bare channel names like "durov"): type=TELEGRAM, url=https://t.me/name
- Twitter/X (@xxx): type=TWITTER, url=https://x.com/name
- YouTube channels or videos (youtube.com/@handle, /channel/, /c/, /user/, youtu.be links): type=YOUTUBE, url=the link
- Direct RSS/Atom feed URLs: type=RSS (but YouTube feeds/videos.xml URLs are type=YOUTUBE)
- Website URLs: type=WEBSITE
- If just a name with no URL and no clear platform context, guess the most likely type

Text:
${text}`,
      abortSignal: AbortSignal.timeout(EXTRACTION_TIMEOUT_MS),
      maxRetries: 1,
      ...(providerOptions ? { providerOptions } : {}),
    })

    return object.feeds.map((f) => {
      // Normalize URL — add https:// if missing, fix t.me links
      let url = f.url
      if (url && !url.startsWith("http")) {
        if (url.startsWith("t.me/")) url = `https://${url}`
        else if (url.includes(".")) url = `https://${url}`
      }
      return resolveStatus({ url, name: f.name, type: f.type, status: "pending" })
    })
  } catch (e) {
    console.error("LLM extraction failed:", e)
    return extractFeedsFromLines(text)
  }
}

export function extractFeedsFromLines(text: string): ExtractedFeed[] {
  const feeds: ExtractedFeed[] = []
  const tgRe = /(?:https?:\/\/)?t\.me\/(\w+)/i
  const twRe = /(?<!\w)@(\w{1,15})\b/
  const urlRe = /https?:\/\/[^\s,)>\]]+/g

  for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const tg = line.match(tgRe)
    if (tg) {
      feeds.push({ url: `https://t.me/${tg[1]}`, name: `@${tg[1]}`, type: "TELEGRAM", status: "found" })
      continue
    }

    const urls = line.match(urlRe)
    if (urls) {
      for (const u of urls) {
        const isYt = YOUTUBE_URL_RE.test(u)
        const isRss = /\/(feed|rss|atom)|\.xml$/.test(u)
        const isTg = u.includes("t.me/")
        const isTw = /x\.com\/|twitter\.com\//.test(u)
        let t: ExtractedFeed["type"] = "WEBSITE"
        // YouTube before RSS: the channel feed-XML form matches the RSS
        // heuristic but should become a transcript-capable YOUTUBE source
        if (isYt) t = "YOUTUBE"
        else if (isRss) t = "RSS"
        else if (isTg) t = "TELEGRAM"
        else if (isTw) t = "TWITTER"
        feeds.push(resolveStatus({
          url: u,
          name: (() => { try { return new URL(u).hostname.replace("www.", "") } catch { return u } })(),
          type: t,
          status: "pending",
        }))
      }
      continue
    }

    const tw = line.match(twRe)
    if (tw) {
      feeds.push({ url: `https://x.com/${tw[1]}`, name: `@${tw[1]}`, type: "TWITTER", status: "found" })
    }
  }

  return feeds
}
