import { describe, expect, it } from "vitest"
import { stripSpanQueryStrings } from "@/lib/sentry-span-scrub"

function span(attributes: Record<string, unknown>) {
  return { trace_id: "t", span_id: "s", name: "GET /reset-password", attributes }
}

describe("stripSpanQueryStrings", () => {
  it("drops the query from Next's raw http.target, which Sentry's urlQueryParams setting never scrubs", () => {
    const out = stripSpanQueryStrings(span({ "http.target": "/reset-password?token=SECRET" }))
    expect(out.attributes["http.target"]).toBe("/reset-password")
  })

  it("handles the { value } attribute form", () => {
    const out = stripSpanQueryStrings(span({ "http.target": { value: "/terms?ref=SECRET" } }))
    expect(out.attributes["http.target"]).toEqual({ value: "/terms" })
  })

  it("covers the other raw URL attributes and removes url.query", () => {
    const out = stripSpanQueryStrings(
      span({ "http.url": "http://x/a?b=SECRET", "url.full": "https://x/c?d=SECRET#h", "url.query": "d=SECRET" }),
    )
    expect(out.attributes).toEqual({ "http.url": "http://x/a", "url.full": "https://x/c" })
    expect(JSON.stringify(out)).not.toContain("SECRET")
  })

  it("leaves query-less URLs and unrelated attributes alone", () => {
    const attrs = { "http.target": "/api/health", "http.method": "GET", "sentry.op": "http.server" }
    expect(stripSpanQueryStrings(span({ ...attrs })).attributes).toEqual(attrs)
  })
})
