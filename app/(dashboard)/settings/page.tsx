import type { Metadata } from "next"
import { SettingsForm } from "@/components/settings/settings-form"
import { db } from "@/lib/db"
import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { getOpenAICompatibleModelName } from "@/lib/models/runtime"

export const metadata: Metadata = { title: "Settings" }
export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function SettingsPage() {
  // Get session to check role
  const session = await auth()
  if (!session?.user?.id) {
    redirect("/signup")
  }

  const userId = session.user.id
  const isAdmin = session.user.role === "ADMIN"

  // Account identity for the Account section. A null row means the env-admin
  // (AUTH_USER) — no DB record to edit, so email stays read-only.
  const accountUser = await db.user.findUnique({
    where: { id: userId },
    select: { email: true, username: true, passwordHash: true },
  })
  const account = {
    email: accountUser?.email ?? null,
    username: accountUser?.username ?? null,
    // Provider-managed (OAuth) accounts have no passwordHash → read-only email.
    // SECURITY: derive a boolean here — never forward passwordHash to the client.
    canEditEmail: accountUser?.passwordHash != null,
  }

  // Fetch global settings (only for admin display)
  const globalSettings = isAdmin ? await db.settings.findFirst() : null

  // Fetch user's personal settings
  let userSettings = await db.userSettings.findUnique({
    where: { userId },
  })

  // Create user settings if they don't exist
  if (!userSettings) {
    userSettings = await db.userSettings.create({
      data: {
        userId,
        globalPrompt: null,
        notionToken: null,
        notionDatabaseId: null,
      },
    })
  }

  // Fetch blacklist (user-specific)
  const blacklist = await db.blacklistItem.findMany({
    where: { userId },
    orderBy: {
      createdAt: "desc",
    },
  })

  // Fetch AI feedback (user-specific)
  const feedback = await db.aIFeedback.findMany({
    where: { userId },
    include: {
      feed: {
        select: {
          id: true,
          name: true,
        },
      },
    },
    orderBy: {
      createdAt: "desc",
    },
    take: 20, // Limit to last 20 feedback items
  })

  // Combine settings for the form
  // Personal settings available to all users
  const personalSettings = {
    globalPrompt: userSettings.globalPrompt,
    // RAD-380: the stored token never reaches the browser. The form holds only
    // a NEW token while one is being typed; a boolean says whether one is saved.
    notionToken: null,
    hasNotionToken: Boolean(userSettings.notionToken),
    notionDatabaseId: userSettings.notionDatabaseId,
    storyInboxChannelId: userSettings.storyInboxChannelId ?? null,
    storyNotionDatabaseId: userSettings.storyNotionDatabaseId ?? null,
    storySystemPrompt: userSettings.storySystemPrompt ?? null,
    storyWriterModel: userSettings.storyWriterModel ?? null,
    storyMatcherModel: userSettings.storyMatcherModel ?? null,
    materialStoryModel: userSettings.materialStoryModel ?? null,
    storyLanguage: userSettings.storyLanguage ?? "en",
    autoDeleteTelegramMessages: userSettings.autoDeleteTelegramMessages ?? false,
    globalLikedCategories: (userSettings.globalLikedCategories as string[]) ?? [],
    globalDislikedCategories: (userSettings.globalDislikedCategories as string[]) ?? [],
  }

  // Global settings only for admins
  const adminSettings = isAdmin && globalSettings ? {
    aiApiKey: globalSettings.aiApiKey,
    aiModel: globalSettings.aiModel,
    aiTemperature: globalSettings.aiTemperature,
    synthesisModel: globalSettings.synthesisModel ?? null,
    discoveryModel: globalSettings.discoveryModel ?? null,
    filterReasoningEffort: globalSettings.filterReasoningEffort ?? null,
    telegramApiId: globalSettings.telegramApiId,
    telegramApiHash: globalSettings.telegramApiHash,
    telegramSessionString: globalSettings.telegramSessionString,
    telegramPhoneNumber: globalSettings.telegramPhoneNumber,
    parallelApiKey: globalSettings.parallelApiKey,
    parallelWebhookSecret: globalSettings.parallelWebhookSecret,
  } : {
    aiApiKey: null,
    aiModel: null,
    aiTemperature: 0.7,
    synthesisModel: null,
    discoveryModel: null,
    filterReasoningEffort: null,
    telegramApiId: null,
    telegramApiHash: null,
    telegramSessionString: null,
    telegramPhoneNumber: null,
    parallelApiKey: null,
    parallelWebhookSecret: null,
  }

  const initialSettings = {
    ...personalSettings,
    ...adminSettings,
  }

  return (
    <SettingsForm
      initialSettings={initialSettings}
      initialBlacklist={blacklist}
      initialFeedback={feedback}
      isAdmin={isAdmin}
      gatewayModelName={isAdmin ? getOpenAICompatibleModelName() : undefined}
      account={account}
    />
  )
}
