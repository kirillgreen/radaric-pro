/**
 * Sentry 11's `dataCollection.urlQueryParams: false` filters query strings only
 * on the attributes Sentry writes itself. Next's own root span sets the raw
 * `http.target` (`req.url`, query included), so a sampled request to
 * `/reset-password?token=…` would ship the reset token. Used as
 * `beforeSendSpan` in instrumentation.ts; measured against a local production
 * build, where `http.target` was the only attribute carrying the query.
 */

const URL_ATTRIBUTES = ["http.target", "http.url", "url.full"] as const

function stripQuery(url: string): string {
  const cut = url.search(/[?#]/)
  return cut === -1 ? url : url.slice(0, cut)
}

export function stripSpanQueryStrings<T extends { attributes?: Record<string, unknown> }>(span: T): T {
  const attributes = span.attributes
  if (!attributes) return span
  for (const key of URL_ATTRIBUTES) {
    const raw = attributes[key]
    if (typeof raw === "string") {
      attributes[key] = stripQuery(raw)
    } else if (raw && typeof raw === "object" && typeof (raw as { value?: unknown }).value === "string") {
      attributes[key] = { ...(raw as object), value: stripQuery((raw as { value: string }).value) }
    }
  }
  delete attributes["url.query"]
  return span
}
