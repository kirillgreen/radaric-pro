"use client"

import { useState, useEffect, useRef } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Card } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { Save, Plus, Trash2, AlertTriangle, Bot, Link2, Filter, ShieldAlert, BookOpen, User, Type } from "lucide-react"
import { toast } from "sonner"
import {
  ANTHROPIC_MODELS,
  OPENROUTER_MODELS,
  STAGE_DEFAULTS,
  REASONING_EFFORTS,
  DEFAULT_REASONING_EFFORT,
  getModelOption,
  type ModelOption,
  type ModelStage,
} from "@/lib/models/registry"
import { TelegramAuthDialog } from "@/components/telegram/telegram-auth-dialog"
import { TelegramAuthBadge, telegramAuthHint } from "@/components/settings/telegram-auth-badge"
import type { TelegramSessionState } from "@/lib/telegram-session-state"
import { ContentCategoryPicker } from "@/components/feeds/content-category-picker"
import { TypographySection } from "@/components/settings/typography-section"
import { prefersReducedMotion } from "@/lib/motion"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

// ---------------------------------------------------------------------------
// Model pickers
//
// ---------------------------------------------------------------------------

const NO_OVERRIDE = "__default__"

/** "GLM-5.3 Flash" for an id we offer, the raw id for one we no longer do. */
function labelForModel(modelId: string): string {
  return getModelOption(modelId)?.label ?? modelId
}

/** "AAI 41.9 · $0.07 / $0.25 per 1M" — enough to choose on, when we have it. */
function modelMeta(model: ModelOption): string | null {
  const parts: string[] = []
  if (model.score !== undefined) parts.push(`AAI ${model.score}`)
  if (model.priceIn !== undefined && model.priceOut !== undefined) {
    parts.push(`$${model.priceIn} / $${model.priceOut} per 1M`)
  }
  return parts.length > 0 ? parts.join(" · ") : null
}

function ModelSelectItems({ models }: { models: ModelOption[] }) {
  return (
    <>
      {models.map((model) => {
        const meta = modelMeta(model)
        return (
          <SelectItem key={model.id} value={model.id}>
            <span className="flex flex-col items-start">
              <span>{model.label}</span>
              {meta && <span className="text-xs text-muted-foreground">{meta}</span>}
            </span>
          </SelectItem>
        )
      })}
    </>
  )
}

/**
 * A stage's model picker.
 *
 * A null value follows the installation's default instead of pinning a model.
 */
function StageModelSelect({
  id,
  defaultModelLabel,
  value,
  onChange,
  includeAnthropic = true,
}: {
  id: string
  defaultModelLabel: string
  value: string | null
  onChange: (value: string | null) => void
  includeAnthropic?: boolean
}) {
  const defaultLabel = `Default (${defaultModelLabel})`
  return (
    <Select
      value={value ?? NO_OVERRIDE}
      onValueChange={(next) => onChange(next === NO_OVERRIDE ? null : next)}
    >
      <SelectTrigger id={id}>
        <SelectValue placeholder={defaultLabel} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NO_OVERRIDE}>{defaultLabel}</SelectItem>
        {includeAnthropic && <ModelSelectItems models={ANTHROPIC_MODELS} />}
        <ModelSelectItems models={OPENROUTER_MODELS} />
      </SelectContent>
    </Select>
  )
}

type Settings = {
  globalPrompt: string | null
  aiModel: string | null
  aiTemperature: number | null
  /** A NEW token being typed — never the stored one, which stays on the server (RAD-380). */
  notionToken: string | null
  /** Whether a Notion token is saved on the server. */
  hasNotionToken: boolean
  notionDatabaseId: string | null
  aiApiKey: string | null
  telegramApiId: number | null
  telegramApiHash: string | null
  telegramSessionString: string | null
  telegramPhoneNumber: string | null
  parallelApiKey: string | null
  parallelWebhookSecret: string | null
  storyInboxChannelId: string | null
  storyNotionDatabaseId: string | null
  storySystemPrompt: string | null
  storyWriterModel: string | null
  storyMatcherModel: string | null
  materialStoryModel: string | null
  synthesisModel: string | null
  discoveryModel: string | null
  filterReasoningEffort: string | null
  storyLanguage: string
  autoDeleteTelegramMessages: boolean
  globalLikedCategories: string[]
  globalDislikedCategories: string[]
}

type BlacklistItem = {
  id: string
  term: string
  matchType: "EXACT" | "CONTAINS" | "REGEX"
  createdAt: Date
}

type AIFeedback = {
  id: string
  commentText: string | null
  isGlobal: boolean
  materialId: string | null
  sourceId: string | null
  createdAt: Date
  feed: {
    id: string
    name: string
  } | null
}

interface SettingsFormProps {
  initialSettings: Settings
  initialBlacklist: BlacklistItem[]
  initialFeedback: AIFeedback[]
  isAdmin?: boolean
  gatewayModelName?: string
  account: {
    email: string | null
    username: string | null
    /** False for provider-managed (OAuth) accounts — email is read-only. */
    canEditEmail: boolean
  }
}

const ADMIN_NAV_ITEMS = [
  { id: "account", label: "Account", icon: User },
  { id: "appearance", label: "Appearance", icon: Type },
  { id: "ai", label: "AI Settings", icon: Bot },
  { id: "integrations", label: "Integrations", icon: Link2 },
  { id: "stories", label: "Stories", icon: BookOpen },
  { id: "filters", label: "Filters", icon: Filter },
  { id: "danger", label: "Danger Zone", icon: ShieldAlert },
]

const USER_NAV_ITEMS = [
  { id: "account", label: "Account", icon: User },
  { id: "appearance", label: "Appearance", icon: Type },
  { id: "integrations", label: "Integrations", icon: Link2 },
  { id: "filters", label: "Filters", icon: Filter },
  { id: "danger", label: "Danger Zone", icon: ShieldAlert },
]

/**
 * The element that actually scrolls this page.
 *
 * On md+ the dashboard shell holds the only scroll container (`<main>` with
 * `md:overflow-y-auto`); the window never scrolls, so `window.scrollY` stays 0
 * and a `window` scroll listener is silent. Walk up from the content column to
 * the nearest ancestor that scrolls, rather than naming `<main>` here. `null`
 * means the document scrolls — the mobile layout, where `<main>` is static.
 */
function scrollContainerOf(el: HTMLElement | null): HTMLElement | null {
  for (let node = el?.parentElement ?? null; node; node = node.parentElement) {
    const { overflowY } = window.getComputedStyle(node)
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) {
      return node
    }
  }
  return null
}

export function SettingsForm({
  initialSettings,
  initialBlacklist,
  initialFeedback,
  isAdmin = false,
  gatewayModelName,
  account,
}: SettingsFormProps) {
  const defaultModelLabel = (stage: ModelStage) =>
    gatewayModelName ? `${gatewayModelName} (via custom gateway)` : labelForModel(STAGE_DEFAULTS[stage])
  const router = useRouter()
  const [settings, setSettings] = useState<Settings>(initialSettings)
  const [emailValue, setEmailValue] = useState(account.email ?? "")
  // Last server-confirmed email — drives the button state immediately on save,
  // without waiting for router.refresh() to re-render the server component.
  const [savedEmail, setSavedEmail] = useState(account.email ?? "")
  const [isSavingEmail, setIsSavingEmail] = useState(false)
  const [emailError, setEmailError] = useState<string | null>(null)
  const [blacklist, setBlacklist] = useState<BlacklistItem[]>(initialBlacklist)
  const [isSaving, setIsSaving] = useState(false)
  const [isTestingNotion, setIsTestingNotion] = useState(false)
  const [isRemovingNotionToken, setIsRemovingNotionToken] = useState(false)
  const [telegramAuthDialogOpen, setTelegramAuthDialogOpen] = useState(false)
  // Live Telegram session state (RAD-328). Starts as `unknown` whenever a
  // number is configured so a dead session is never flashed as "Not
  // authorized" and never assumed authorized before the worker answers.
  const [telegramSessionState, setTelegramSessionState] = useState<TelegramSessionState>(
    initialSettings.telegramPhoneNumber ? "unknown" : "unconfigured"
  )
  const [telegramStatusNonce, setTelegramStatusNonce] = useState(0)
  const [clearMaterialsDialogOpen, setClearMaterialsDialogOpen] = useState(false)
  const [isClearingMaterials, setIsClearingMaterials] = useState(false)
  const [activeSection, setActiveSection] = useState("account")
  const [newBlacklistItem, setNewBlacklistItem] = useState({
    term: "",
    matchType: "CONTAINS" as "EXACT" | "CONTAINS" | "REGEX",
  })

  // Highlight the section the reader is looking at. The page scrolls inside the
  // dashboard's `<main>` on md+ and inside the document on mobile, so listen in
  // the capture phase on `document`: scroll does not bubble, but every
  // element's scroll reaches the document that way, and the event target says
  // which container is scrolling — no selector to guess and nothing to rebind
  // when the breakpoint or the content height changes.
  //
  // A click owns the highlight while its section stays on screen: the last two
  // short sections collide at the bottom (`Filters` cannot top-align while
  // `Danger Zone` sits below it), so the bottom rule would otherwise hand a
  // clicked section's highlight to the last one. Scroll events alone cannot
  // tell the click's own smooth scroll from the reader's — a long
  // `scrollIntoView` emits several `scrollend`s on the way — so the claim ends
  // on input that only a reader produces, or when its section leaves the pane.
  const contentRef = useRef<HTMLDivElement>(null)
  const clickClaimRef = useRef<{ id: string; seen: boolean } | null>(null)
  useEffect(() => {
    const container = contentRef.current
    if (!container) return

    // Where the reading position sits below the top of the scrollport. Sections
    // scroll into view under `scroll-mt-28` (112px), safely inside this line.
    const ACTIVE_LINE = 180

    const updateActiveSection = (pane: Element | null) => {
      const viewTop = pane ? pane.getBoundingClientRect().top : 0
      const viewBottom = pane ? viewTop + pane.clientHeight : window.innerHeight

      const claim = clickClaimRef.current
      if (claim) {
        const rect = container
          .querySelector<HTMLElement>(`[data-section="${claim.id}"]`)
          ?.getBoundingClientRect()
        const onScreen = !!rect && rect.bottom > viewTop && rect.top < viewBottom
        // The click's own smooth scroll starts with the section still off
        // screen, so the claim starts policing visibility only once the section
        // has arrived; from then on, a scroll that takes it away ends the claim.
        if (onScreen) claim.seen = true
        if (onScreen || !claim.seen) return
        clickClaimRef.current = null
      }

      const sections = Array.from(container.querySelectorAll<HTMLElement>("[data-section]"))
      if (sections.length === 0) return

      // Short trailing sections — Filters, Danger Zone — never cross the
      // active line before the page bottoms out, so the bottom belongs to the
      // last one.
      const atBottom = pane
        ? pane.scrollHeight > pane.clientHeight &&
          pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 2
        : document.documentElement.scrollHeight > window.innerHeight &&
          window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2
      if (atBottom) {
        setActiveSection(sections[sections.length - 1].getAttribute("data-section") || "account")
        return
      }

      let current = sections[0].getAttribute("data-section") || "account"
      for (const section of sections) {
        if (section.getBoundingClientRect().top <= viewTop + ACTIVE_LINE) {
          current = section.getAttribute("data-section") || current
        }
      }
      setActiveSection(current)
    }

    const handleScroll = (event: Event) => {
      const target = event.target
      // Ignore scrolls from panes that do not hold these sections (a popover's
      // list, the sidebar). The document scrolling is dispatched at `document`.
      if (target instanceof Element && !target.contains(container)) return
      updateActiveSection(target instanceof Element ? target : null)
    }

    const releaseClickClaim = () => {
      clickClaimRef.current = null
    }
    const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "])
    const releaseOnScrollKey = (event: KeyboardEvent) => {
      if (SCROLL_KEYS.has(event.key)) releaseClickClaim()
    }

    document.addEventListener("scroll", handleScroll, { capture: true, passive: true })
    window.addEventListener("wheel", releaseClickClaim, { passive: true })
    window.addEventListener("touchmove", releaseClickClaim, { passive: true })
    window.addEventListener("keydown", releaseOnScrollKey)
    // A restored scroll position (reload, back/forward) arrives before any
    // event, so seed the highlight from where the page actually is.
    updateActiveSection(scrollContainerOf(container))
    return () => {
      document.removeEventListener("scroll", handleScroll, { capture: true })
      window.removeEventListener("wheel", releaseClickClaim)
      window.removeEventListener("touchmove", releaseClickClaim)
      window.removeEventListener("keydown", releaseOnScrollKey)
    }
  }, [])

  useEffect(() => {
    // Validate model IDs — reset removed/invalid models to defaults
    const allModelIds = new Set([
      ...ANTHROPIC_MODELS.map(m => m.id),
      ...OPENROUTER_MODELS.map(m => m.id),
    ])
    const validated = { ...initialSettings }
    if (validated.aiModel && !allModelIds.has(validated.aiModel)) {
      console.warn(`[Settings] Invalid aiModel "${validated.aiModel}", resetting to default`)
      validated.aiModel = null
    }
    setSettings(validated)
  }, [initialSettings])

  useEffect(() => {
    setBlacklist(initialBlacklist)
  }, [initialBlacklist])

  // Ask the worker for the live session state (admins with a number only).
  // Non-terminal answers keep polling: the worker may be mid-reconnect or
  // mid-deploy, and the badge must not freeze on a stale "Connecting…".
  useEffect(() => {
    if (!isAdmin || !settings.telegramPhoneNumber) {
      setTelegramSessionState(settings.telegramPhoneNumber ? "unknown" : "unconfigured")
      return
    }

    let cancelled = false
    let pollTimer: ReturnType<typeof setTimeout> | undefined

    const load = () => {
      fetch("/api/telegram/auth/status")
        .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
        .then((data: { state?: TelegramSessionState; authenticated?: boolean }) => {
          if (cancelled) return
          const state = data.state ?? (data.authenticated ? "active" : "unknown")
          setTelegramSessionState(state)
          if (state === "starting" || state === "unknown") {
            pollTimer = setTimeout(load, 10_000)
          }
        })
        .catch(() => {
          if (cancelled) return
          setTelegramSessionState("unknown")
          pollTimer = setTimeout(load, 10_000)
        })
    }

    load()
    return () => {
      cancelled = true
      if (pollTimer) clearTimeout(pollTimer)
    }
  }, [isAdmin, settings.telegramPhoneNumber, telegramStatusNonce])

  async function handleSaveSettings() {
    setIsSaving(true)
    try {
      const userSettingsResponse = await fetch("/api/user-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          globalPrompt: settings.globalPrompt,
          // Write-only (RAD-380): sent only when a new token was typed; an
          // absent key keeps the saved one.
          ...(settings.notionToken?.trim() ? { notionToken: settings.notionToken.trim() } : {}),
          notionDatabaseId: settings.notionDatabaseId,
          storyInboxChannelId: settings.storyInboxChannelId,
          storyNotionDatabaseId: settings.storyNotionDatabaseId,
          storySystemPrompt: settings.storySystemPrompt,
          storyWriterModel: settings.storyWriterModel,
          storyMatcherModel: settings.storyMatcherModel,
          materialStoryModel: settings.materialStoryModel,
          storyLanguage: settings.storyLanguage,
          autoDeleteTelegramMessages: settings.autoDeleteTelegramMessages,
          globalLikedCategories: settings.globalLikedCategories,
          globalDislikedCategories: settings.globalDislikedCategories,
        }),
      })

      if (!userSettingsResponse.ok) {
        const data = await userSettingsResponse.json().catch(() => null)
        throw new Error(data?.error ?? "Failed to save personal settings")
      }

      if (isAdmin) {
        const globalSettingsResponse = await fetch("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            aiApiKey: settings.aiApiKey,
            aiModel: settings.aiModel,
            aiTemperature: settings.aiTemperature,
            synthesisModel: settings.synthesisModel,
            discoveryModel: settings.discoveryModel,
            filterReasoningEffort: settings.filterReasoningEffort,
            telegramApiId: settings.telegramApiId,
            telegramApiHash: settings.telegramApiHash,
            telegramSessionString: settings.telegramSessionString,
            telegramPhoneNumber: settings.telegramPhoneNumber,
            parallelApiKey: settings.parallelApiKey,
            parallelWebhookSecret: settings.parallelWebhookSecret,
          }),
        })

        if (!globalSettingsResponse.ok) {
          throw new Error("Failed to save global settings")
        }
      }

      // The typed token is now saved server-side: drop it from the client and
      // show the saved state (router.refresh does not reset useState).
      setSettings((prev) => ({
        ...prev,
        notionToken: null,
        hasNotionToken: prev.hasNotionToken || Boolean(prev.notionToken?.trim()),
      }))
      toast.success("Settings saved")
      router.refresh()
    } catch (error) {
      console.error("Error saving settings:", error)
      toast.error(error instanceof Error ? error.message : "Failed to save settings")
    } finally {
      setIsSaving(false)
    }
  }

  async function handleTestNotion() {
    const typedToken = settings.notionToken?.trim()
    if ((!typedToken && !settings.hasNotionToken) || !settings.notionDatabaseId) {
      toast.error("Fill in the token and database ID")
      return
    }

    setIsTestingNotion(true)
    try {
      const response = await fetch("/api/settings/test-notion", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Without a typed token the server tests the saved one.
        body: JSON.stringify({
          ...(typedToken ? { token: typedToken } : {}),
          databaseId: settings.notionDatabaseId,
        }),
      })

      if (!response.ok) {
        throw new Error("Failed to connect to Notion")
      }

      toast.success("Notion connection successful")
    } catch (error) {
      console.error("Error testing Notion:", error)
      toast.error("Failed to connect to Notion")
    } finally {
      setIsTestingNotion(false)
    }
  }

  async function handleRemoveNotionToken() {
    setIsRemovingNotionToken(true)
    try {
      const response = await fetch("/api/user-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notionToken: null }),
      })
      if (!response.ok) throw new Error("Failed to remove the Notion token")
      setSettings((prev) => ({ ...prev, notionToken: null, hasNotionToken: false }))
      toast.success("Notion token removed")
      router.refresh()
    } catch (error) {
      console.error("Error removing Notion token:", error)
      toast.error("Failed to remove the Notion token")
    } finally {
      setIsRemovingNotionToken(false)
    }
  }

  async function handleTelegramLogout() {
    try {
      const response = await fetch("/api/telegram/auth/logout", {
        method: "POST",
      })

      if (!response.ok) {
        throw new Error("Failed to logout from Telegram")
      }

      setSettings({
        ...settings,
        telegramPhoneNumber: null,
      })
      toast.success("Signed out of Telegram")
      router.refresh()
    } catch (error) {
      console.error("Error logging out from Telegram:", error)
      toast.error("Failed to sign out of Telegram")
    }
  }

  async function handleAddBlacklistItem() {
    if (!newBlacklistItem.term) {
      toast.error("Fill in the pattern")
      return
    }

    try {
      const response = await fetch("/api/blacklist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newBlacklistItem),
      })

      if (!response.ok) {
        throw new Error("Failed to add blacklist item")
      }

      const item = await response.json()
      setBlacklist([item, ...blacklist])
      setNewBlacklistItem({ term: "", matchType: "CONTAINS" })
      toast.success("Item added to blocklist")
    } catch (error) {
      console.error("Error adding blacklist item:", error)
      toast.error("Failed to add item")
    }
  }

  async function handleDeleteBlacklistItem(id: string) {
    try {
      const response = await fetch(`/api/blacklist/${id}`, {
        method: "DELETE",
      })

      if (!response.ok) {
        throw new Error("Failed to delete blacklist item")
      }

      setBlacklist(blacklist.filter((item) => item.id !== id))
      toast.success("Item removed from blocklist")
    } catch (error) {
      console.error("Error deleting blacklist item:", error)
      toast.error("Failed to remove item")
    }
  }

  async function handleClearAllMaterials() {
    setIsClearingMaterials(true)
    try {
      const response = await fetch("/api/posts/clear", {
        method: "DELETE",
      })

      if (!response.ok) {
        throw new Error("Failed to clear materials")
      }

      const result = await response.json()
      toast.success(`Materials deleted: ${result.count}`)
      setClearMaterialsDialogOpen(false)
      router.refresh()
    } catch (error) {
      console.error("Error clearing materials:", error)
      toast.error("Failed to delete posts")
    } finally {
      setIsClearingMaterials(false)
    }
  }

  function scrollToSection(id: string) {
    const el = contentRef.current?.querySelector(`[data-section="${id}"]`)
    if (!el) return
    // Sections carry `scroll-mt-28`, so scrollIntoView lands them clear of the
    // sticky header and scrolls whichever ancestor actually scrolls.
    el.scrollIntoView({
      block: "start",
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    })
    setActiveSection(id)
    clickClaimRef.current = { id, seen: false }
    // Reflect the anchor without a Next navigation or a new history entry.
    window.history.replaceState(null, "", `#${id}`)
  }

  // Deep-link support: /settings#account scrolls to the section on load.
  useEffect(() => {
    const hash = window.location.hash.replace("#", "")
    if (hash && contentRef.current?.querySelector(`[data-section="${hash}"]`)) {
      requestAnimationFrame(() => scrollToSection(hash))
    }
  }, [])

  async function handleSaveEmail() {
    setIsSavingEmail(true)
    setEmailError(null)
    try {
      const res = await fetch("/api/user/email", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: emailValue.trim() }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setEmailError(data.error || "Failed to update email.")
        return
      }
      // Only adopt a value the server actually confirmed.
      const confirmed = typeof data.email === "string" ? data.email : null
      if (confirmed) {
        setEmailValue(confirmed)
        setSavedEmail(confirmed)
      }
      toast.success("Email updated")
      router.refresh()
    } catch {
      setEmailError("Network error. Try again.")
    } finally {
      setIsSavingEmail(false)
    }
  }

  return (
    <div className="p-4 lg:p-8">
      <div className="max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between mt-2 lg:mt-4">
        <div>
          <h1 className="text-xl md:text-2xl font-bold">Settings</h1>
          <p className="text-sm text-muted-foreground hidden sm:block">
            Manage application settings
          </p>
        </div>
        <Button onClick={handleSaveSettings} disabled={isSaving} size="sm" className="md:text-base md:h-9">
          <Save className="h-[16px] w-[16px] md:mr-2" />
          <span className="hidden md:inline">{isSaving ? "Saving..." : "Save"}</span>
        </Button>
      </div>

      {/* Two-column layout: sidebar nav + content */}
      <div className="flex gap-8">
        {/* Left nav — sticky */}
        <nav aria-label="Settings sections" className="hidden md:block w-48 shrink-0">
          <div className="sticky top-20 space-y-1">
            {(isAdmin ? ADMIN_NAV_ITEMS : USER_NAV_ITEMS).map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => scrollToSection(id)}
                aria-current={activeSection === id ? "location" : undefined}
                className={`w-full flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${
                  activeSection === id
                    ? "text-foreground font-semibold bg-accent"
                    : "text-muted-foreground font-medium hover:text-foreground hover:bg-accent/50"
                }`}
              >
                <Icon className="h-[16px] w-[16px]" />
                {label}
              </button>
            ))}
          </div>
        </nav>

        {/* Right content — all sections */}
        <div ref={contentRef} className="flex-1 min-w-0 space-y-10">

          {/* Section: Account (all users) */}
          <div data-section="account" className="space-y-6 scroll-mt-28">
            <SectionHeading icon={User} title="Account" />

            <SettingsSection
              title="Email"
              description="Used for billing and receipts. A subscription requires an email address."
            >
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="accountEmail">Email address</Label>
                  <Input
                    id="accountEmail"
                    type="email"
                    autoComplete="email"
                    placeholder="you@example.com"
                    value={emailValue}
                    disabled={!account.canEditEmail || isSavingEmail}
                    onChange={(e) => {
                      setEmailValue(e.target.value)
                      setEmailError(null)
                    }}
                  />
                  {!account.canEditEmail ? (
                    <p className="text-xs text-muted-foreground">
                      Managed by your Google/Apple sign-in.
                    </p>
                  ) : savedEmail ? (
                    <p className="text-xs text-muted-foreground">
                      Changing this updates your billing email.
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Add an email to enable subscriptions and billing receipts.
                    </p>
                  )}
                  {emailError && <p className="text-sm text-destructive">{emailError}</p>}
                </div>

                {account.canEditEmail && (
                  <Button
                    onClick={handleSaveEmail}
                    disabled={
                      isSavingEmail ||
                      emailValue.trim() === "" ||
                      emailValue.trim().toLowerCase() === savedEmail.toLowerCase()
                    }
                  >
                    {isSavingEmail ? "Saving..." : savedEmail ? "Update email" : "Add email"}
                  </Button>
                )}

                {account.username && (
                  <div className="space-y-2 border-t border-border/60 pt-4">
                    <Label htmlFor="accountUsername">Username</Label>
                    <Input id="accountUsername" value={account.username} disabled readOnly />
                    <p className="text-xs text-muted-foreground">
                      Your unique handle — you can also sign in with it.
                    </p>
                  </div>
                )}
              </div>
            </SettingsSection>
          </div>

          {/* Section: Appearance (all users) */}
          <div data-section="appearance" className="space-y-6 scroll-mt-28">
            <SectionHeading icon={Type} title="Appearance" />

            <SettingsSection
              title="Typography"
              description="Choose a font for each role. Changes apply instantly and are saved to your account."
            >
              <TypographySection />
            </SettingsSection>
          </div>

          {/* Section: AI & Prompt (admin only) */}
          {isAdmin && (
          <div data-section="ai" className="space-y-6 scroll-mt-28">
            <SectionHeading icon={Bot} title="AI Settings" />

            <SettingsSection
                title="AI Settings"
                description="API keys and model selection for all AI features"
              >
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="aiApiKey">Anthropic API Key</Label>
                    <Input
                      id="aiApiKey"
                      type="password"
                      placeholder={
                        settings.aiApiKey
                          ? "••••••••"
                          : "sk-ant-... (or use environment variable)"
                      }
                      value={settings.aiApiKey || ""}
                      onChange={(e) =>
                        setSettings({ ...settings, aiApiKey: e.target.value })
                      }
                    />
                    <p className="text-xs text-muted-foreground">
                      {settings.aiApiKey
                        ? "Using key from settings"
                        : "Using ANTHROPIC_API_KEY from environment variables"}
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="aiModel">Content filtering model</Label>
                    <StageModelSelect
                      id="aiModel"
                      defaultModelLabel={defaultModelLabel("filtering")}
                      value={settings.aiModel}
                      onChange={(value) => setSettings({ ...settings, aiModel: value })}
                    />
                    <p className="text-xs text-muted-foreground">
                      Used by &quot;Run AI Rules&quot; and during parsing to evaluate each material.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="aiTemperature">
                      Temperature: {settings.aiTemperature}
                    </Label>
                    <Input
                      id="aiTemperature"
                      type="range"
                      min="0"
                      max="1"
                      step="0.1"
                      value={settings.aiTemperature || 0.7}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          aiTemperature: parseFloat(e.target.value),
                        })
                      }
                    />
                    <p className="text-xs text-muted-foreground">
                      Lower values make responses more predictable
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="filterReasoningEffort">Reasoning effort</Label>
                    <Select
                      value={settings.filterReasoningEffort ?? NO_OVERRIDE}
                      onValueChange={(value) =>
                        setSettings({
                          ...settings,
                          filterReasoningEffort: value === NO_OVERRIDE ? null : value,
                        })
                      }
                    >
                      <SelectTrigger id="filterReasoningEffort">
                        <SelectValue placeholder={`Default (${DEFAULT_REASONING_EFFORT})`} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NO_OVERRIDE}>
                          Default ({DEFAULT_REASONING_EFFORT})
                        </SelectItem>
                        {REASONING_EFFORTS.map((effort) => (
                          <SelectItem key={effort} value={effort}>
                            {effort}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      How long the model thinks before answering. Ignored by models that
                      take no reasoning parameter. Thinking bills at the output rate.
                    </p>
                  </div>

                  <div className="space-y-2 pt-4">
                    <Label htmlFor="materialStoryModel">Material grouping model</Label>
                    <StageModelSelect
                      id="materialStoryModel"
                      defaultModelLabel={defaultModelLabel("materialStory")}
                      value={settings.materialStoryModel}
                      onChange={(value) => setSettings({ ...settings, materialStoryModel: value })}
                      includeAnthropic={false}
                    />
                    <p className="text-xs text-muted-foreground">
                      Used by &quot;Group Stories&quot; — matches and writes stories from feed materials.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="storyWriterModel">Telegram inbox story writer</Label>
                    <StageModelSelect
                      id="storyWriterModel"
                      defaultModelLabel={defaultModelLabel("storyWriter")}
                      value={settings.storyWriterModel}
                      onChange={(value) => setSettings({ ...settings, storyWriterModel: value })}
                    />
                    <p className="text-xs text-muted-foreground">
                      Generates stories from Telegram inbox items. This is prose a human
                      reads — the first stage worth escalating if the writing reads flat.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="storyMatcherModel">Telegram inbox deduplication</Label>
                    <StageModelSelect
                      id="storyMatcherModel"
                      defaultModelLabel={defaultModelLabel("storyMatcher")}
                      value={settings.storyMatcherModel}
                      onChange={(value) => setSettings({ ...settings, storyMatcherModel: value })}
                    />
                    <p className="text-xs text-muted-foreground">
                      Checks if a Telegram inbox item matches an existing story.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="synthesisModel">Library synthesis model</Label>
                    <StageModelSelect
                      id="synthesisModel"
                      defaultModelLabel={defaultModelLabel("synthesis")}
                      value={settings.synthesisModel}
                      onChange={(value) => setSettings({ ...settings, synthesisModel: value })}
                    />
                    <p className="text-xs text-muted-foreground">
                      Maintains the living answer for each Library collection. Also prose —
                      escalate this one alongside the story writer.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="discoveryModel">Source discovery model</Label>
                    <StageModelSelect
                      id="discoveryModel"
                      defaultModelLabel={defaultModelLabel("discovery")}
                      value={settings.discoveryModel}
                      onChange={(value) => setSettings({ ...settings, discoveryModel: value })}
                    />
                    <p className="text-xs text-muted-foreground">
                      Suggests publications for a tracked question. Every suggestion is
                      validated against a real RSS feed before it reaches you.
                    </p>
                  </div>
                </div>
              </SettingsSection>
          </div>
          )}

          {/* Section: Integrations */}
          <div data-section="integrations" className="space-y-6 scroll-mt-28">
            <SectionHeading icon={Link2} title="Integrations" />

            <SettingsSection
              title="Notion Integration"
              description="Configure connection to the Notion database"
            >
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="notionToken">Integration Token</Label>
                  <Input
                    id="notionToken"
                    type="password"
                    autoComplete="off"
                    placeholder={
                      settings.hasNotionToken
                        ? "•••••••• saved — paste a new token to replace it"
                        : "secret_... (optional, if not using Notion)"
                    }
                    value={settings.notionToken || ""}
                    onChange={(e) =>
                      setSettings({ ...settings, notionToken: e.target.value })
                    }
                  />
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-xs text-muted-foreground">
                      {settings.hasNotionToken
                        ? "A token is saved. For security it is never shown again."
                        : "Fill in to enable Notion integration"}
                    </p>
                    {settings.hasNotionToken && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={handleRemoveNotionToken}
                        disabled={isRemovingNotionToken}
                      >
                        {isRemovingNotionToken ? "Removing..." : "Remove token"}
                      </Button>
                    )}
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="notionDatabaseId">Database ID</Label>
                  <Input
                    id="notionDatabaseId"
                    placeholder="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                    value={settings.notionDatabaseId || ""}
                    onChange={(e) =>
                      setSettings({ ...settings, notionDatabaseId: e.target.value })
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    Notion database ID for saving materials
                  </p>
                </div>

                <Button
                  variant="outline"
                  onClick={handleTestNotion}
                  disabled={isTestingNotion}
                >
                  {isTestingNotion ? "Checking..." : "Test Connection"}
                </Button>
              </div>
            </SettingsSection>

            {isAdmin && (
              <SettingsSection
                title="Telegram Integration"
                description="Configure Telegram channel parsing"
              >
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="telegramApiId">API ID</Label>
                    <Input
                      id="telegramApiId"
                      type="number"
                      placeholder="Get it at my.telegram.org"
                      value={settings.telegramApiId || ""}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          telegramApiId: e.target.value ? parseInt(e.target.value) : null,
                        })
                      }
                    />
                    <p className="text-xs text-muted-foreground">
                      Numeric application identifier from Telegram
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="telegramApiHash">API Hash</Label>
                    <Input
                      id="telegramApiHash"
                      type="password"
                      placeholder={
                        settings.telegramApiHash
                          ? "••••••••"
                          : "Get it at my.telegram.org"
                      }
                      value={settings.telegramApiHash || ""}
                      onChange={(e) =>
                        setSettings({ ...settings, telegramApiHash: e.target.value })
                      }
                    />
                    <p className="text-xs text-muted-foreground">
                      String application key from Telegram
                    </p>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label>Authorization Status</Label>
                      <TelegramAuthBadge
                        state={telegramSessionState}
                        phoneNumber={settings.telegramPhoneNumber}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {telegramAuthHint(telegramSessionState)}
                    </p>
                  </div>

                  <div className="flex gap-2">
                    {settings.telegramPhoneNumber ? (
                      <Button
                        variant="outline"
                        onClick={handleTelegramLogout}
                      >
                        Sign out of Telegram
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        onClick={() => setTelegramAuthDialogOpen(true)}
                        disabled={!settings.telegramApiId || !settings.telegramApiHash}
                      >
                        Sign in to Telegram
                      </Button>
                    )}
                  </div>

                  <p className="text-xs text-muted-foreground pl-3">
                    <strong>How to get API credentials:</strong><br />
                    1. Go to <a href="https://my.telegram.org" target="_blank" rel="noopener noreferrer" className="link">my.telegram.org</a><br />
                    2. Sign in with your phone number<br />
                    3. Navigate to the &quot;API Development Tools&quot; section<br />
                    4. Create a new application or use an existing one<br />
                    5. Copy the API ID and API Hash here
                  </p>
                </div>
              </SettingsSection>
            )}


            {isAdmin && (
              <SettingsSection
                title="Event Trigger API"
                description="Internet monitoring via Parallel AI"
              >
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="parallelApiKey">API Key</Label>
                    <Input
                      id="parallelApiKey"
                      type="password"
                      placeholder={
                        settings.parallelApiKey
                          ? "••••••••"
                          : "Get it at platform.parallel.ai"
                      }
                      value={settings.parallelApiKey || ""}
                      onChange={(e) =>
                        setSettings({ ...settings, parallelApiKey: e.target.value })
                      }
                    />
                    <p className="text-xs text-muted-foreground">
                      {settings.parallelApiKey
                        ? "API key configured — you can create Event Triggers"
                        : "Without a key, creating Event Triggers is unavailable"}
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="parallelWebhookSecret">Webhook Secret (optional)</Label>
                    <Input
                      id="parallelWebhookSecret"
                      type="password"
                      placeholder={
                        settings.parallelWebhookSecret
                          ? "••••••••"
                          : "For verifying webhook requests"
                      }
                      value={settings.parallelWebhookSecret || ""}
                      onChange={(e) =>
                        setSettings({ ...settings, parallelWebhookSecret: e.target.value })
                      }
                    />
                    <p className="text-xs text-muted-foreground">
                      Used to verify the authenticity of webhook notifications
                    </p>
                  </div>

                  <p className="text-xs text-muted-foreground pl-3">
                    <strong>How to get an API key:</strong><br />
                    1. Go to <a href="https://platform.parallel.ai" target="_blank" rel="noopener noreferrer" className="link">platform.parallel.ai</a><br />
                    2. Create an account or sign in<br />
                    3. Navigate to the API Keys section<br />
                    4. Create a new key and copy it here
                  </p>
                </div>
              </SettingsSection>
            )}
          </div>

          {/* Section: Stories */}
          {isAdmin && (
          <div data-section="stories" className="space-y-6 scroll-mt-28">
            <SectionHeading icon={BookOpen} title="Stories" />

            {isAdmin && (
              <SettingsSection
                title="Telegram Channel"
                description="ID of the private channel from which Story Aggregator receives materials"
              >
                <div className="space-y-2">
                  <Label htmlFor="storyInboxChannelId">Channel ID</Label>
                  <Input
                    id="storyInboxChannelId"
                    placeholder="-1001234567890"
                    value={settings.storyInboxChannelId || ""}
                    onChange={(e) =>
                      setSettings({ ...settings, storyInboxChannelId: e.target.value })
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    Telegram channel ID (starts with -100). Get it via @userinfobot or API.
                  </p>
                </div>
              </SettingsSection>
            )}

            {isAdmin && (
              <SettingsSection
                title="Notion for Stories"
                description='Notion "Digest Inbox" database for saving stories'
              >
                <div className="space-y-2">
                  <Label htmlFor="storyNotionDatabaseId">Database ID</Label>
                  <Input
                    id="storyNotionDatabaseId"
                    placeholder="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                    value={settings.storyNotionDatabaseId || ""}
                    onChange={(e) =>
                      setSettings({ ...settings, storyNotionDatabaseId: e.target.value })
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    ID of the &quot;Digest Inbox&quot; database in Notion. Different from the main materials database above.
                  </p>
                </div>
              </SettingsSection>
            )}

            {isAdmin && (
              <SettingsSection
                title="Auto-delete from Telegram"
                description="Delete messages from the inbox channel after successfully saving to Notion"
              >
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label htmlFor="autoDeleteTelegram">Delete after saving to Notion</Label>
                    <p className="text-xs text-muted-foreground">
                      The message will be deleted from Telegram only after confirmed saving to Notion.
                      On error the message will remain untouched.
                    </p>
                  </div>
                  <Switch
                    id="autoDeleteTelegram"
                    checked={settings.autoDeleteTelegramMessages}
                    onCheckedChange={(checked) =>
                      setSettings({ ...settings, autoDeleteTelegramMessages: checked })
                    }
                  />
                </div>
              </SettingsSection>
            )}

            <SettingsSection
              title="Story Language"
              description="Language for AI-generated story text"
            >
              <div className="space-y-2">
                <Label htmlFor="storyLanguage">Output language</Label>
                <Select
                  value={settings.storyLanguage || "en"}
                  onValueChange={(value) =>
                    setSettings({ ...settings, storyLanguage: value })
                  }
                >
                  <SelectTrigger id="storyLanguage">
                    <SelectValue placeholder="English" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="en">English</SelectItem>
                    <SelectItem value="ru">Russian</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Stories will be written in this language, regardless of feed language.
                </p>
              </div>
            </SettingsSection>

            <SettingsSection
              title="Story Prompt"
              description="System prompt for AI story generation"
            >
              <div className="space-y-2">
                <Textarea
                  placeholder="You are an editor of the digest..."
                  rows={8}
                  value={settings.storySystemPrompt || ""}
                  onChange={(e) =>
                    setSettings({ ...settings, storySystemPrompt: e.target.value })
                  }
                />
                <p className="text-xs text-muted-foreground">
                  If left empty, the default prompt from code is used. You can customize style,
                  tone, and section priorities.
                </p>
              </div>
            </SettingsSection>
          </div>
          )}

          {/* Section: Filters */}
          <div data-section="filters" className="space-y-6 scroll-mt-28">
            <SectionHeading icon={Filter} title="Filters" />

            <SettingsSection
              title="Global Content Interests"
              description="Categories that apply to all feeds. AI uses these as a baseline when no per-feed categories are set."
            >
              <ContentCategoryPicker
                likedCategories={settings.globalLikedCategories}
                dislikedCategories={settings.globalDislikedCategories}
                onLikedChange={(cats) => setSettings({ ...settings, globalLikedCategories: cats })}
                onDislikedChange={(cats) => setSettings({ ...settings, globalDislikedCategories: cats })}
              />
            </SettingsSection>
          </div>

          {/* Section: Danger Zone */}
          <div data-section="danger" className="space-y-6 scroll-mt-28">
            <SectionHeading icon={ShieldAlert} title="Danger Zone" />

            <SettingsSection
              title="Danger Zone"
              description="Irreversible actions — use with caution"
            >
              <div className="rounded-lg bg-destructive-subtle p-4 space-y-3">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="h-[20px] w-[20px] text-destructive flex-shrink-0 mt-0.5" />
                  <div className="flex-1 space-y-2">
                    <div>
                      <h3 className="font-semibold text-destructive">
                        Delete all posts
                      </h3>
                      <p className="text-sm text-muted-foreground mt-1">
                        This action will delete all collected posts from the database.
                        Feeds will remain untouched. Use for parser testing
                        or a full data reset.
                      </p>
                    </div>
                    <Button
                      variant="destructive"
                      onClick={() => setClearMaterialsDialogOpen(true)}
                      className="w-full sm:w-auto"
                    >
                      <Trash2 className="mr-2 h-[16px] w-[16px]" />
                      Delete all posts
                    </Button>
                  </div>
                </div>
              </div>
            </SettingsSection>
          </div>

        </div>
      </div>
      </div>

      {/* Telegram Auth Dialog */}
      <TelegramAuthDialog
        open={telegramAuthDialogOpen}
        onOpenChange={setTelegramAuthDialogOpen}
        onSuccess={(phoneNumber) => {
          setSettings(prev => ({
            ...prev,
            telegramPhoneNumber: phoneNumber
          }))
          // The worker re-auth happens asynchronously; the effect above
          // refetches now and keeps polling while the worker reconnects.
          setTelegramStatusNonce(n => n + 1)
          toast.success("Authorization successful!")
          router.refresh()
        }}
      />

      {/* Clear Materials Confirmation Dialog */}
      <Dialog open={clearMaterialsDialogOpen} onOpenChange={setClearMaterialsDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-[20px] w-[20px]" />
              Confirm Deletion
            </DialogTitle>
            <DialogDescription>
              Are you sure you want to delete ALL posts from the database?
              <br />
              <br />
              This action will:
              <ul className="list-disc list-inside mt-2 space-y-1">
                <li>Delete all collected posts</li>
                <li>Keep all feeds</li>
                <li>Keep all settings</li>
                <li><strong>Cannot be undone</strong></li>
              </ul>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              onClick={() => setClearMaterialsDialogOpen(false)}
              disabled={isClearingMaterials}
            >
              Cancel
            </Button>
            <Button
              variant="destructive-solid"
              onClick={handleClearAllMaterials}
              disabled={isClearingMaterials}
            >
              {isClearingMaterials ? "Deleting..." : "Delete all posts"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function SectionHeading({ icon: Icon, title }: { icon: React.ComponentType<{ className?: string }>; title: string }) {
  return (
    <div className="flex items-center gap-2 pb-2">
      <Icon className="h-[16px] w-[16px] text-muted-foreground" />
      <h2 className="text-lg font-semibold">{title}</h2>
    </div>
  )
}

function SettingsSection({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: React.ReactNode
}) {
  return (
    <div className="rounded-xl surface-card p-6">
      <h2 className="text-base font-semibold">{title}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      <div className="mt-5">{children}</div>
    </div>
  )
}
