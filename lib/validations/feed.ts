import { z } from "zod"
import { USER_PROMPT_MAX } from "@/lib/validations/prompt-limits"

export const twitterSourceTypeSchema = z.enum(["ACCOUNT", "SEARCH"])
export type TwitterSourceType = z.infer<typeof twitterSourceTypeSchema>

export const interestCadenceSchema = z.enum(["HOURLY", "DAILY", "WEEKLY"])
export type InterestCadence = z.infer<typeof interestCadenceSchema>

/**
 * Extract a Twitter/X username from various input formats:
 * - username
 * - @username
 * - https://twitter.com/username
 * - https://x.com/username
 * - twitter.com/username
 * - x.com/username
 */
export function extractTwitterUsername(input: string): string {
  let value = input.trim()
  // Strip URL formats: optional protocol + any subdomain (www., mobile., …) + twitter.com or x.com
  value = value.replace(/^(?:https?:\/\/)?(?:[\w-]+\.)*(?:twitter\.com|x\.com)\//, "")
  // Strip @ prefix
  value = value.replace(/^@/, "")
  // Remove trailing slashes or query params
  value = value.replace(/[/?#].*$/, "")
  return value
}

// Telegram's own username grammar: a letter first, letters/digits/underscore,
// no "__", not ending in "_", 4–32 chars (4 = collectible handles). Anything
// looser can only ever resolve through the worker session's cache.
const TELEGRAM_USERNAME_RE = /^[A-Za-z](?!.*__)[A-Za-z0-9_]{2,30}[A-Za-z0-9]$/
// t.me path prefixes that are NOT channel usernames
const TELEGRAM_RESERVED = new Set(["joinchat", "share", "addstickers", "addtheme", "proxy", "socks", "bg", "login"])
// Strings GramJS resolves to the session's OWN account (client/users.js:
// getInputEntity → InputPeerSelf; _getEntityFromString lowercases first).
const TELEGRAM_SELF_ALIASES = new Set(["me", "self", "this"])

/**
 * Could this string only ever be looked up as a public @username?
 *
 * Besides the grammar (RAD-364): GramJS reads an all-digit string as a peer id
 * — resolvable against the session's cached contacts and chats — and
 * "self"/"this" as the session's own account.
 */
export function isPublicTelegramUsername(username: string): boolean {
  return (
    TELEGRAM_USERNAME_RE.test(username) &&
    !/^\d+$/.test(username) &&
    !TELEGRAM_SELF_ALIASES.has(username.toLowerCase())
  )
}

/**
 * A private invite link: t.me/+<hash> or t.me/joinchat/<hash>. An all-digit
 * "+…" is a phone link (t.me/+<phone>), not an invite.
 */
export function isTelegramInviteLink(input: string): boolean {
  const m = input
    .trim()
    .match(/^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\/(?:\+|joinchat\/)([A-Za-z0-9_-]+)\/?$/i)
  return !!m && !/^\d+$/.test(m[1])
}

/**
 * Normalize any public-channel paste format to the canonical https://t.me/<channel>:
 * @channel · channel · t.me/channel · https://t.me/channel · telegram.me/channel ·
 * t.me/s/channel (web preview) · t.me/channel/123 (post link) · tg://resolve?domain=channel
 * Returns null for private invite links (t.me/+…, joinchat), phone numbers,
 * peer ids, the self aliases, and non-Telegram input.
 */
export function normalizeTelegramInput(input: string): string | null {
  let s = input.trim()
  if (!s) return null

  const tgScheme = s.match(/^tg:\/\/resolve\?domain=([A-Za-z0-9_]+)/i)
  if (tgScheme) {
    s = tgScheme[1]
  } else {
    const urlForm = s.match(/^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\/(.+)$/i)
    if (urlForm) {
      if (urlForm[1].startsWith("+")) return null // private invite link
      const segments = urlForm[1].split(/[/?#]/).filter(Boolean)
      let candidate = segments[0]
      if (candidate?.toLowerCase() === "s" && segments[1]) {
        candidate = segments[1] // web-preview form t.me/s/<channel>
      }
      // Check the FINAL candidate so t.me/s/<reserved> can't bypass the guard
      if (candidate && TELEGRAM_RESERVED.has(candidate.toLowerCase())) {
        return null
      }
      s = candidate ?? ""
    } else if (!s.startsWith("@") && /^(?:https?:\/\/|[\w-]+\.\w)/.test(s)) {
      // Some other URL or domain — not a Telegram handle
      return null
    }
  }

  s = s.replace(/^@/, "")
  if (!isPublicTelegramUsername(s)) return null
  return `https://t.me/${s}`
}

export type TelegramInputRejectCode = "TELEGRAM_PRIVATE_INVITE" | "TELEGRAM_INVALID_INPUT"

/**
 * The TELEGRAM feed URL to store — the canonical https://t.me/<channel> — or
 * why not. Every write path (POST, PATCH, onboarding save-feeds) goes through
 * this one gate. Private invite links are refused: the worker reads only
 * public channels, so a stored invite would fail on every parse (RAD-364).
 */
export function vetTelegramFeedInput(
  input: string
): { ok: true; url: string } | { ok: false; code: TelegramInputRejectCode } {
  const url = normalizeTelegramInput(input)
  if (url) return { ok: true, url }
  return { ok: false, code: isTelegramInviteLink(input) ? "TELEGRAM_PRIVATE_INVITE" : "TELEGRAM_INVALID_INPUT" }
}

// YouTube input normalization lives in the client-safe pure module (NOT
// lib/youtube.ts — its transcript dependency would drag Node APIs into the
// browser bundle via this re-export, since feed-form imports from here).
export { normalizeYouTubeInput } from "@/lib/youtube-url"

/**
 * Lenient RSS URL input: pass full URLs through, prefix https:// on
 * protocol-less host/path pastes, reject anything that isn't URL-shaped.
 */
export function normalizeFeedUrlInput(input: string): string | null {
  const s = input.trim()
  if (!s) return null
  if (/^https?:\/\//i.test(s)) return s
  if (/^[\w-]+(\.[\w-]+)+(?::\d+)?(?:[/?#]\S*)?$/.test(s)) return `https://${s}`
  return null
}

const categoryListSchema = z.array(z.string().min(1).max(50).trim()).max(30)

// The bare object, without the cross-field refinements below. `updateSourceSchema`
// is built from it: zod >= 4.6 refuses `.partial()` on a refined object, and
// zod 4.1's `.partial()` dropped the refinements anyway, so a PATCH never ran them.
const sourceObjectSchema = z.object({
  // URL is required for RSS/TELEGRAM, optional for TWITTER/INTEREST (auto-generated)
  url: z.string().url({ message: "Enter a valid URL" }).optional().or(z.literal("")),
  type: z.enum(["RSS", "TELEGRAM", "TWITTER", "INTEREST", "EVENT_TRIGGER", "YOUTUBE"]),
  name: z.string().min(1, { message: "Name is required" }),
  coverUrl: z.string().url().optional().or(z.literal("")),
  // RAD-369: capped server-side; the per-feed prompt feeds the evaluation prompt.
  customPrompt: z
    .string()
    .max(USER_PROMPT_MAX, { message: `Custom prompt is too long (max ${USER_PROMPT_MAX} characters)` })
    .optional(),
  isActive: z.boolean(),

  // Twitter-specific fields
  twitterType: twitterSourceTypeSchema.optional(),
  twitterValue: z.string().optional(),

  // Interest-specific fields (Parallel Monitor API)
  interestQuery: z.string().optional(),
  interestCadence: interestCadenceSchema.optional(),

  // Twitter-specific: include retweets (default: off)
  includeRetweets: z.boolean().optional(),

  // Content category preferences
  likedCategories: categoryListSchema.default([]),
  dislikedCategories: categoryListSchema.default([]),
})

export const sourceSchema = sourceObjectSchema
  .refine(
    (data) => {
      // URL required for RSS, TELEGRAM, and YOUTUBE
      if (data.type === "RSS" || data.type === "TELEGRAM" || data.type === "YOUTUBE") {
        return !!data.url && data.url.length > 0
      }
      return true
    },
    {
      message: "URL is required for RSS, Telegram, and YouTube sources",
      path: ["url"],
    }
  )
  .refine(
    (data) => {
      // Twitter fields required for TWITTER type
      if (data.type === "TWITTER") {
        return !!data.twitterType && !!data.twitterValue && data.twitterValue.trim().length > 0
      }
      return true
    },
    {
      message: "Specify type and value for Twitter source",
      path: ["twitterValue"],
    }
  )
  .refine(
    (data) => {
      // Validate Twitter username format
      if (data.type === "TWITTER" && data.twitterType === "ACCOUNT" && data.twitterValue) {
        const cleaned = extractTwitterUsername(data.twitterValue)
        return /^[A-Za-z0-9_]{1,15}$/.test(cleaned)
      }
      return true
    },
    {
      message: "Invalid Twitter username format (max 15 characters, only letters, digits, _)",
      path: ["twitterValue"],
    }
  )
  .refine(
    (data) => {
      // Validate Twitter search query
      if (data.type === "TWITTER" && data.twitterType === "SEARCH" && data.twitterValue) {
        const trimmed = data.twitterValue.trim()
        return trimmed.length >= 2 && trimmed.length <= 500
      }
      return true
    },
    {
      message: "Search query must be between 2 and 500 characters",
      path: ["twitterValue"],
    }
  )
  .refine(
    (data) => {
      // Interest query required for INTEREST type
      if (data.type === "INTEREST" || data.type === "EVENT_TRIGGER") {
        return !!data.interestQuery && data.interestQuery.trim().length >= 10
      }
      return true
    },
    {
      message: "Describe the interest (minimum 10 characters)",
      path: ["interestQuery"],
    }
  )
  .refine(
    (data) => {
      // Interest cadence required for INTEREST type
      if (data.type === "INTEREST" || data.type === "EVENT_TRIGGER") {
        return !!data.interestCadence
      }
      return true
    },
    {
      message: "Select check frequency",
      path: ["interestCadence"],
    }
  )

export type SourceFormData = z.infer<typeof sourceSchema>

export const createSourceSchema = sourceSchema

// No defaults on a PATCH: a field the request did not send stays undefined, so
// the route leaves its column alone. A defaulted [] here erased a feed's
// categories every time the feed card paused or resumed it.
export const updateSourceSchema = sourceObjectSchema.partial().extend({
  id: z.string(),
  likedCategories: categoryListSchema.optional(),
  dislikedCategories: categoryListSchema.optional(),
})
