/**
 * `updateSourceSchema` is the PATCH schema for `/api/feeds/[id]`. It is built
 * from the bare source object, not from the refined `sourceSchema`: zod >= 4.6
 * throws at module load on `.partial()` of a refined object (which broke every
 * route importing `lib/validations/feed`), and zod 4.1 dropped the refinements
 * on `.partial()` anyway. These tests pin that behavior across zod upgrades.
 */
import { describe, it, expect } from "vitest"
import { sourceSchema, updateSourceSchema } from "@/lib/validations/feed"

describe("updateSourceSchema", () => {
  it("accepts a partial update with only an id and one field", () => {
    const parsed = updateSourceSchema.parse({ id: "src_1", name: "Renamed" })
    expect(parsed.id).toBe("src_1")
    expect(parsed.name).toBe("Renamed")
  })

  it("requires the id", () => {
    expect(updateSourceSchema.safeParse({ name: "Renamed" }).success).toBe(false)
  })

  it("still validates each field it receives", () => {
    expect(updateSourceSchema.safeParse({ id: "src_1", name: "" }).success).toBe(false)
    expect(updateSourceSchema.safeParse({ id: "src_1", url: "not a url" }).success).toBe(false)
  })

  it("does not invent category lists a PATCH did not send", () => {
    const parsed = updateSourceSchema.parse({ id: "src_1", isActive: false })
    expect(parsed).not.toHaveProperty("likedCategories")
    expect(parsed).not.toHaveProperty("dislikedCategories")
  })

  it("does not run the create-time cross-field refinements", () => {
    // An RSS source without a URL fails create, but a PATCH that only sends the
    // type must not be rejected for the URL it did not send.
    expect(sourceSchema.safeParse({ type: "RSS", name: "Feed", isActive: true }).success).toBe(false)
    expect(updateSourceSchema.safeParse({ id: "src_1", type: "RSS" }).success).toBe(true)
  })
})
