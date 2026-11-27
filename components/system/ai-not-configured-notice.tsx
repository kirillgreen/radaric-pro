import Link from "next/link"
import { TriangleAlert } from "lucide-react"
import { auth } from "@/lib/auth"
import { getMissingFilteringModelSetting } from "@/lib/ai-config"

/**
 * RAD-293: "AI provider not configured" banner. Without this, a fresh install
 * shows AI as broken — every source flips to status:"ERROR" with a generic
 * message instead of naming the actual problem.
 *
 * The predicate is MODEL-AWARE (lib/ai-config): the default filtering model is
 * an OpenRouter model, so an Anthropic-only key does not make filtering work
 * and must not silence the banner.
 */
export async function AiNotConfiguredNotice() {
  const session = await auth()
  if (!session?.user?.id) return null

  const missingSetting = await getMissingFilteringModelSetting()
  if (!missingSetting) return null

  const isAdmin = session.user.role === "ADMIN"
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-2 border-b border-hairline bg-secondary px-4 py-2.5 text-sm"
    >
      <TriangleAlert className="h-4 w-4 shrink-0 text-warning" aria-hidden />
      <p>
        {isAdmin ? (
          <>
            AI filtering is not configured — set{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{missingSetting}</code> in the
            environment, or pick a Claude model for filtering and add an Anthropic key in{" "}
            {/* The banner sits on --secondary, where --primary falls below AA —
                so the link wears link-on-tint (the sanctioned zone remap). */}
            <Link
              href="/settings"
              className="font-medium link link-on-tint"
            >
              Settings
            </Link>
            .
          </>
        ) : (
          <>AI filtering is not configured — ask your instance administrator to check the AI settings.</>
        )}
      </p>
    </div>
  )
}
