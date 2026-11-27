/**
 * Worker Entry Point for Story Aggregator
 * Launched alongside Next.js via start script (see package.json).
 *
 * Responsibilities:
 * 1. GramJS listener for inbox channel (real-time message processing)
 *    - Album event: handles grouped media (photos/videos) as a single unit
 *    - NewMessage event: handles single (non-album) messages
 * 2. HTTP health check server on port 3001 (WORKER_HEALTH_PORT)
 * 3. Sequential processing queue (concurrency=1)
 * 4. Album grouping (native GramJS Album event for real-time, AlbumGrouper for catch-up)
 * 5. Catch-up on startup (last 200 messages since storyLastMessageId, with 20-msg buffer)
 * 6. Retry daemon (15-min interval for ERROR items)
 * 7. Graceful shutdown (SIGTERM)
 *
 * Spec: the Story Aggregator specification, sections 2.3-2.5
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- GramJS has no exported types for events, entities, and messages */

import http from "node:http"
import { PrismaClient } from "@prisma/client"
import { ProcessingQueue } from "./processing-queue"
import { AlbumGrouper, type TelegramMessage, type GroupedMessage } from "./album-grouper"
import { WorkerHealthCheck, healthHttpStatus } from "./health-check"
import { RetryDaemon } from "./retry-daemon"
import { processInboxItem, type PipelineDeps } from "./pipeline"
import { extractContentFromUrl, extractContentFromText } from "./content-extractor"
import { StoryOutputSchema } from "./schemas"
import { matchItem as matchItemFn, type StoryMatcherDeps } from "./story-matcher"
import { findRelatedMaterials, type ArchiveLinkerDeps } from "./archive-linker"
import { replaceNotionPageContent } from "./notion-page-update"
import {
  extractPollText,
  downloadMessageMedia,
  downloadMediaBatch,
} from "./worker-helpers"
import { channelInfo, parseChannelResponse } from "./telegram-proxy"
import { maybeDeleteTelegramMessage, sweepUndeletedTelegramMessages } from "./telegram-deleter"
import { previewImageUrl } from "@/lib/media-urls"
import { openNotionToken } from "@/lib/notion-token"
import { requiresAnthropicKey, buildProviderOptions } from "@/lib/models/registry"
import { resolveRuntimeModelForStage } from "@/lib/models/runtime"
import { storyOverridesFor, type StorySettingsRow } from "./story-entitlement"
import { createModelInstance } from "@/lib/models/provider"
import {
  STORY_GENERATION_TIMEOUT_MS,
  STORY_MATCHING_TIMEOUT_MS,
  STORY_AI_MAX_RETRIES,
} from "./ai-limits"
import { runGapScan, type GapScanDeps, GAP_SCAN_CUTOFF_TS } from "./gap-scan"
import { createGramJSLock } from "./gramjs-lock"
import { connectTelegramClient, destroyTelegramClient, disposeGramJSSession } from "./gramjs-client"
import { GramJSLockUnavailableError, GramJSClientDestroyError } from "./gramjs-errors"
import { createGramJSLifecycle } from "./gramjs-lifecycle"
import { generateObject } from "ai"
import { sweepDueCollections, reconcileOrphanMonitors, reconcileMonitorsForAccess } from "@/lib/saved/subscription"
import { routeRecentMaterials } from "@/lib/saved/routing"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HEALTH_PORT = parseInt(process.env.WORKER_HEALTH_PORT || "3001", 10)
const CATCH_UP_LIMIT = 200
const RETRY_INTERVAL_MS = 15 * 60 * 1000 // 15 minutes
const WATCHDOG_INTERVAL_MS = 90_000 // 90 seconds between pings
const PING_TIMEOUT_MS = 30_000 // 30s timeout for getMe() ping
const DESTROY_TIMEOUT_MS = 10_000 // 10s timeout for destroy() in reconnect paths
const GAP_SCAN_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes between gap scans
const SELF_FILLING_SWEEP_INTERVAL_MS = parseInt(process.env.SELF_FILLING_SWEEP_INTERVAL_MS || "120000", 10) // 2 min

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const db = new PrismaClient()
const healthCheck = new WorkerHealthCheck()
const albumGrouper = new AlbumGrouper(10_000) // 10s debounce
let gramjsClient: any = null
let httpServer: http.Server | null = null
let watchdogInterval: ReturnType<typeof setInterval> | null = null
let gapScanInterval: ReturnType<typeof setInterval> | null = null
let selfFillingSweepInterval: ReturnType<typeof setInterval> | null = null
let isReconnecting = false
let telegramSweepRunning = false
let workerChannelId: string | null = null
let workerChannelUsername: string | null = null
let workerUserId: string | null = null

// Single owner of the session lifecycle: the lock, the setup retry policy and
// every restart request (watchdog, lock loss, re-auth) funnel through it. See
// gramjs-lifecycle.ts for why: in production a restart could be silently
// skipped while the watchdog reported success, and a lock that was silently
// dropped left a client running with no owner.
const gramjsLock = createGramJSLock({
  onLost: () => {
    // Drop the client BEFORE queueing the restart: requestRestart defers its
    // teardown behind an in-flight pass, and a client must never outlive the
    // lock that authorized it.
    console.error("[Worker] Session lock lost — dropping the GramJS client now")
    void (async () => {
      await teardownGramJS()
      await gramjsLifecycle.requestRestart("session lock lost")
    })()
  },
})

const gramjsLifecycle = createGramJSLifecycle({
  setup: setupGramJS,
  teardown: teardownGramJS,
  onStateChange: (state) => healthCheck.setGramjsState(state),
  onFatal: (reason) => {
    console.error(`[Worker] ${reason} — exiting so Railway restarts the worker`)
    process.exit(1)
  },
})

// ---------------------------------------------------------------------------
// Pipeline deps factory
// ---------------------------------------------------------------------------

async function buildPipelineDeps(userId: string): Promise<PipelineDeps> {
  const [settings, userSettings, user] = await Promise.all([
    db.settings.findFirst(),
    db.userSettings.findUnique({ where: { userId } }),
    db.user.findUnique({ where: { id: userId }, select: { role: true } }),
  ])
  // RAD-369 — the same read-time entitlement the HTTP dep factories use, because
  // this factory is NOT admin-only: the retry daemon re-runs every user's ERROR
  // inbox items, and a non-admin creates one through POST /api/posts/[id]/stories.
  const overrides = storyOverridesFor(user?.role)
  // Resolve FIRST, then demand a credential — and only the credential the
  // resolved models actually use. The worker used to throw on a missing
  // Anthropic key before it knew which models it was about to run.
  const writerModel = resolveRuntimeModelForStage("storyWriter", overrides.model(userSettings?.storyWriterModel))
  const matcherModel = resolveRuntimeModelForStage("storyMatcher", overrides.model(userSettings?.storyMatcherModel))

  const anthropicApiKey = settings?.aiApiKey || process.env.ANTHROPIC_API_KEY
  if (!anthropicApiKey && [writerModel, matcherModel].some(requiresAnthropicKey)) {
    throw new Error("ANTHROPIC_API_KEY not configured")
  }

  // Reasoning effort, resolved once per factory rather than per call.
  const writerOptions = buildProviderOptions(writerModel)
  const matcherOptions = buildProviderOptions(matcherModel)

  return {
    db: {
      inboxItem: db.inboxItem as unknown as PipelineDeps["db"]["inboxItem"],
      story: db.story as unknown as PipelineDeps["db"]["story"],
      // The prompt is masked here, not just the model: the pipeline reads it
      // through this dep (pipeline.ts generateAndSaveStory / saveStoryToNotion).
      userSettings: {
        findUnique: async (args) => {
          const row = await db.userSettings.findUnique(args as never)
          return overrides.settings(row as StorySettingsRow | null) as never
        },
        update: (args) => db.userSettings.update(args as never),
      } as PipelineDeps["db"]["userSettings"],
    },
    generateStory: async (systemPrompt: string, userContent: string) => {
      const result = await generateObject({
        model: await createModelInstance(writerModel, { anthropicApiKey }),
        schema: StoryOutputSchema,
        system: systemPrompt,
        prompt: userContent,
        temperature: 0.3,
        abortSignal: AbortSignal.timeout(STORY_GENERATION_TIMEOUT_MS),
        maxRetries: STORY_AI_MAX_RETRIES,
        ...(writerOptions ? { providerOptions: writerOptions } : {}),
      })
      return result.object
    },
    saveToNotion: async (databaseId, properties, blocks) => {
      if (!userSettings?.notionToken) {
        throw new Error("Notion token not configured")
      }
      const { Client } = await import("@notionhq/client")
      const notion = new Client({ auth: openNotionToken(userSettings.notionToken, userId) })

      const allBlocks = blocks as any[]
      const firstBatch = allBlocks.slice(0, 100)
      const remaining = allBlocks.slice(100)

      const page = await notion.pages.create({
        parent: { database_id: databaseId },
        properties: properties as any,
        children: firstBatch as any,
      } as any)

      for (let i = 0; i < remaining.length; i += 100) {
        await notion.blocks.children.append({
          block_id: page.id,
          children: remaining.slice(i, i + 100) as any,
        } as any)
      }

      return {
        pageId: page.id,
        url: (page as any).url || `https://notion.so/${page.id.replace(/-/g, "")}`,
      }
    },
    updateNotionPage: async (pageId, properties, blocks) => {
      if (!userSettings?.notionToken) {
        throw new Error("Notion token not configured")
      }
      const { Client } = await import("@notionhq/client")
      const notion = new Client({ auth: openNotionToken(userSettings.notionToken, userId) })

      // Append-before-delete: a failed append must not leave an empty page.
      await replaceNotionPageContent(notion, pageId, properties, blocks as unknown[])
    },
    extractContent: {
      fromUrl: extractContentFromUrl,
      fromText: extractContentFromText,
    },
    matchItem: async (itemId, userId) => {
      const matcherDeps: StoryMatcherDeps = {
        db: {
          story: { findMany: (args) => db.story.findMany(args as any) },
          inboxItem: { findUnique: (args) => db.inboxItem.findUnique(args as any) as any },
        },
        matchWithAI: async (systemPrompt, userContent) => {
          const { generateText } = await import("ai")
          const result = await generateText({
            model: await createModelInstance(matcherModel, { anthropicApiKey }),
            system: systemPrompt,
            prompt: userContent,
            abortSignal: AbortSignal.timeout(STORY_MATCHING_TIMEOUT_MS),
            maxRetries: STORY_AI_MAX_RETRIES,
            ...(matcherOptions ? { providerOptions: matcherOptions } : {}),
          })
          // Strip ```json ... ``` fences before parsing. pipeline-deps.ts has done
          // this since it was written; this path never did, so any model that wraps
          // its JSON fell through to the raw-text branch here while working there.
          let text = result.text.trim()
          const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/)
          if (jsonMatch) text = jsonMatch[1].trim()
          try {
            return JSON.parse(text)
          } catch {
            console.error(`[StoryMatcher] Failed to parse AI response: ${text.slice(0, 200)}`)
            return text
          }
        },
      }
      return matchItemFn(itemId, userId, matcherDeps)
    },
    findRelatedMaterials: async (storyTitle, storySummary) => {
      const archiveDbUrl = process.env.ARCHIVE_DATABASE_URL
      if (!archiveDbUrl) return []

      const linkerDeps: ArchiveLinkerDeps = {
        generateEmbedding: async (text) => {
          const { default: OpenAI } = await import("openai")
          const openai = new OpenAI()
          const response = await openai.embeddings.create({
            model: "text-embedding-3-small",
            input: text,
          })
          return response.data[0].embedding
        },
        queryMaterials: async (embedding, limit) => {
          const { PrismaClient: ArchivePrisma } = await import("@prisma/client")
          const archiveDb = new ArchivePrisma({ datasources: { db: { url: archiveDbUrl } } })
          try {
            if (!embedding.every(v => typeof v === 'number' && isFinite(v))) throw new Error('Invalid embedding values')
            const vectorStr = `[${embedding.join(",")}]`
            const results = await archiveDb.$queryRawUnsafe(`
              SELECT title, url, description, issue_number as "issueNumber",
                     rubrics, 1 - (embedding_vector <=> $1::vector) as similarity
              FROM materials
              WHERE embedding_vector IS NOT NULL
              ORDER BY embedding_vector <=> $1::vector
              LIMIT $2
            `, vectorStr, limit) as any[]
            return results.map((r: any) => ({
              title: r.title,
              url: r.url,
              description: r.description,
              issueNumber: r.issueNumber,
              rubrics: r.rubrics || [],
              similarity: parseFloat(r.similarity),
            }))
          } finally {
            await archiveDb.$disconnect()
          }
        },
      }
      return findRelatedMaterials(storyTitle, storySummary, linkerDeps)
    },
  }
}

// ---------------------------------------------------------------------------
// Post-pipeline success hook (Telegram message deletion)
// ---------------------------------------------------------------------------

async function onPipelineSuccess(itemId: string, userId: string, notionPageId: string | undefined): Promise<void> {
  // Only proceed if Notion actually saved (notionPageId is non-null)
  if (!notionPageId) return

  try {
    const userSettings = await db.userSettings.findUnique({ where: { userId } })
    if (!userSettings?.storyInboxChannelId) return

    await maybeDeleteTelegramMessage(itemId, {
      db: { inboxItem: db.inboxItem },
      gramjsClient,
      channelId: userSettings.storyInboxChannelId,
      autoDeleteEnabled: userSettings.autoDeleteTelegramMessages,
    })
  } catch (error) {
    // Non-blocking: deletion failure must never affect the pipeline result
    console.warn(`[Worker] onPipelineSuccess error for item ${itemId}:`, error)
  }
}

// ---------------------------------------------------------------------------
// Processing Queue
// ---------------------------------------------------------------------------

const processingQueue = new ProcessingQueue<string>(async (itemId: string) => {
  try {
    const item = await db.inboxItem.findUnique({ where: { id: itemId } })
    if (!item) {
      console.error(`[Worker] InboxItem not found: ${itemId}`)
      return
    }
    const deps = await buildPipelineDeps(item.userId)
    const result = await processInboxItem(itemId, deps)

    if (result.success) {
      console.log(`[Worker] Processed item ${itemId} -> story ${result.storyId}`)
      healthCheck.recordSuccessfulPoll()
      await onPipelineSuccess(itemId, item.userId, result.notionPageId)
    } else {
      console.error(`[Worker] Failed to process item ${itemId}: ${result.error}`)
    }
  } catch (error) {
    console.error(`[Worker] Unhandled error processing item ${itemId}:`, error)
  }
})

// ---------------------------------------------------------------------------
// Retry Daemon
// ---------------------------------------------------------------------------

const retryDaemon = new RetryDaemon(RETRY_INTERVAL_MS, async (itemId: string) => {
  const item = await db.inboxItem.findUnique({ where: { id: itemId } })
  if (!item) return
  const deps = await buildPipelineDeps(item.userId)
  const result = await processInboxItem(itemId, deps)
  if (result.success) {
    await onPipelineSuccess(itemId, item.userId, result.notionPageId)
  }
})

// ---------------------------------------------------------------------------
// Telegram entity URL extraction
// ---------------------------------------------------------------------------

/**
 * Extract text from a GramJS message, including URLs from MessageEntityTextUrl
 * entities (hyperlinks where the URL is hidden behind anchor text).
 * Plain URLs (MessageEntityUrl) are already in message.text.
 */
function extractTextWithEntityUrls(message: any): string | null {
  const text: string | null = message.text || message.message || null

  if (!message.entities || !Array.isArray(message.entities)) {
    return text
  }

  const entityUrls: string[] = []
  for (const entity of message.entities) {
    if (entity.className === "MessageEntityTextUrl" && entity.url) {
      entityUrls.push(entity.url)
    }
  }

  if (entityUrls.length === 0) return text

  // Append entity URLs that aren't already visible in the text
  const urlsNotInText = entityUrls.filter((url) => !text?.includes(url))
  if (urlsNotInText.length === 0) return text

  return (text || "") + "\n\n" + urlsNotInText.join("\n")
}

// ---------------------------------------------------------------------------
// Telegram post URL resolution (for forwarded messages)
// ---------------------------------------------------------------------------

/**
 * Resolve the original Telegram post URL for a forwarded message.
 * Returns null for direct (non-forwarded) messages or on any error.
 *
 * For public channels: https://t.me/{username}/{channelPost}
 * For private channels: https://t.me/c/{channelId}/{channelPost}
 */
async function resolveTelegramPostUrl(
  client: any,
  message: any
): Promise<string | null> {
  const fwdFrom = message.fwdFrom
  if (!fwdFrom) return null

  const channelPost: number | null = fwdFrom.channelPost ?? null
  if (!channelPost) return null

  const fromId = fwdFrom.fromId
  if (!fromId || fromId.className !== "PeerChannel") return null

  const channelId: bigint = fromId.channelId

  try {
    const entity = await client.getEntity(channelId)
    if (entity.username) {
      return `https://t.me/${entity.username}/${channelPost}`
    }
    // Private channel — use numeric ID notation
    return `https://t.me/c/${channelId.toString()}/${channelPost}`
  } catch {
    console.warn(`[Worker] Could not resolve entity for channelId ${channelId}`)
    return null
  }
}

// ---------------------------------------------------------------------------
// Message ingestion
// ---------------------------------------------------------------------------

async function ingestMessage(grouped: GroupedMessage, userId: string, channelId: string): Promise<string | null> {
  const externalId = `${channelId}:${grouped.primaryMessageId}`

  // Dedup check
  const existing = await db.inboxItem.findUnique({
    where: { externalId },
  })
  if (existing) {
    console.log(`[Worker] Skipping duplicate: ${externalId}`)
    return null
  }

  // Extract primary URL from text
  const urlMatch = grouped.text?.match(/https?:\/\/[^\s<>]+/)
  const extractedUrl = urlMatch ? urlMatch[0] : null

  // A cover image only — the poster carried by the grouping, else the first
  // image in mediaUrls. Never a playable URL (OG image still takes precedence
  // in the pipeline). (RAD-359)
  const thumbnailUrl =
    grouped.thumbnailUrl ?? previewImageUrl({ thumbnailUrl: null, mediaUrls: grouped.mediaUrls })

  const item = await db.inboxItem.create({
    data: {
      userId,
      externalId,
      messageId: grouped.primaryMessageId,
      rawText: grouped.text,
      extractedUrl,
      mediaUrls: grouped.mediaUrls,
      thumbnailUrl,
      telegramPostUrl: grouped.telegramPostUrl,
      allMessageIds: grouped.messageIds,
      status: "PENDING",
    },
  })

  console.log(`[Worker] Ingested item ${item.id} (msg ${grouped.primaryMessageId})`)

  // Enqueue for processing
  processingQueue.enqueue(item.id)

  return item.id
}

// ---------------------------------------------------------------------------
// GramJS listener setup
// ---------------------------------------------------------------------------

async function setupGramJS(): Promise<"connected" | "unconfigured"> {
  const lockAcquired = await gramjsLock.acquire()
  if (!lockAcquired) {
    // A live peer holds the session — a normal deploy-overlap state. The
    // lifecycle waits for it; setup must never "succeed" without a client.
    throw new GramJSLockUnavailableError()
  }

  let client: any = null
  try {
    const { TelegramClient, Api } = await import("telegram")
    const { StringSession } = await import("telegram/sessions")

    const settings = await db.settings.findFirst()
    if (!settings?.telegramApiId || !settings?.telegramApiHash || !settings?.telegramSessionString) {
      console.warn("[Worker] Telegram credentials not configured. Running without GramJS listener.")
      await gramjsLock.release()
      return "unconfigured"
    }

    // Find ADMIN user with story settings (inbox channel is admin-only)
    const userSettings = await db.userSettings.findFirst({
      where: {
        storyInboxChannelId: { not: null },
        user: { role: "ADMIN" },
      },
    })

    if (!userSettings?.storyInboxChannelId) {
      console.warn("[Worker] No story inbox channel configured. Running without GramJS listener.")
      await gramjsLock.release()
      return "unconfigured"
    }

    const channelId = userSettings.storyInboxChannelId
    const userId = userSettings.userId

    console.log(`[Worker] Setting up GramJS for channel ${channelId}`)

    const session = new StringSession(settings.telegramSessionString)
    client = new TelegramClient(
      session,
      settings.telegramApiId,
      settings.telegramApiHash,
      { connectionRetries: 5 }
    )

    // Ownership can vanish mid-setup (the lock is a DB session, and managed
    // Postgres may recycle sessions). Never connect without it.
    if (!gramjsLock.isOwned()) throw new GramJSLockUnavailableError()

    // GramJS connect() resolves false (and arms its own reconnect loop) or
    // throws; either way the client must be destroyed or it keeps retrying
    // with the same auth key as an orphan nobody references.
    await connectTelegramClient(client)
    gramjsClient = client
    healthCheck.setGramjsConnected(true)

    // Entity cache warm-up (spec requirement 2.5.3)
  console.log("[Worker] Warming up entity cache...")
  await client.getDialogs({ limit: 100 })

  // Resolve channel username for R2 media storage paths
  let channelUsername: string
  try {
    const channelEntity: any = await client.getEntity(BigInt(channelId) as any)
    channelUsername = channelEntity.username || channelId.replace(/^-/, "")
  } catch {
    channelUsername = channelId.replace(/^-/, "")
  }
  console.log(`[Worker] Channel username for media: ${channelUsername}`)

  // Store for gap scan use
  workerChannelId = channelId
  workerChannelUsername = channelUsername
  workerUserId = userId

  healthCheck.setGramjsConnected(true)

  // Register event handlers
  const { NewMessage } = await import("telegram/events")
  const { Album } = await import("telegram/events/Album")

  // Album handler — receives complete albums with all messages grouped.
  // This replaces the custom AlbumGrouper for real-time events, avoiding
  // the race condition where slow media downloads caused album splitting.
  client.addEventHandler(
    async (event: any) => {
      try {
        const messages: any[] = event.messages
        if (!messages || messages.length === 0) return

        // WORKAROUND: GramJS Album.build() bypasses EventBuilder.filter() —
        // the `chats` parameter in `new Album({ chats: [...] })` has NO effect.
        // Album.build() calls dispatch() directly inside setTimeout, returning
        // undefined to _dispatchUpdate, so filter() never runs. Without this
        // guard, albums from EVERY subscribed channel enter the pipeline.
        const peer = messages[0]?.peerId
        if (!peer?.channelId) return // not a channel message
        const rawId = peer.channelId.toString()
        const expectedRawId = channelId.slice(4) // strip "-100" Bot API prefix
        if (rawId !== expectedRawId) {
          console.log(`[Worker] Album from foreign channel ${rawId}, ignoring (expected ${expectedRawId})`)
          return
        }

        const sorted = [...messages].sort((a: any, b: any) => a.id - b.id)

        // Extract text from all messages FIRST (no network calls, instant)
        const text = sorted
          .map((msg: any) => extractTextWithEntityUrls(msg) ?? extractPollText(msg))
          .find((t: string | null) => t !== null) ?? null

        // Download media AFTER grouping (no race condition)
        const [telegramPostUrls, mediaResults] = await Promise.all([
          Promise.all(sorted.map((msg: any) => resolveTelegramPostUrl(client, msg))),
          downloadMediaBatch(client, sorted, channelUsername),
        ])

        const mediaUrls = mediaResults
          .map((r) => r.url)
          .filter((url): url is string => url !== null)

        // A cover an <img> can paint: first photo result, else the first
        // video/audio poster. Never a playable URL (RAD-359).
        const photo = mediaResults.find((r) => r.type === "photo" && r.url !== null)
        const thumbnailUrl =
          photo?.url ?? mediaResults.find((r) => r.thumbUrl !== null)?.thumbUrl ?? null

        const telegramPostUrl = telegramPostUrls.find((u) => u !== null) ?? null

        const grouped: GroupedMessage = {
          messageIds: sorted.map((m: any) => m.id),
          primaryMessageId: sorted[0].id,
          text,
          mediaUrls,
          thumbnailUrl,
          groupedId: sorted[0].groupedId?.toString() ?? null,
          date: sorted[0].date,
          telegramPostUrl,
        }

        await ingestMessage(grouped, userId, channelId)

        // Update last message ID to the highest in the album
        const lastId = Math.max(...sorted.map((m: any) => m.id))
        await db.userSettings.update({
          where: { userId },
          data: { storyLastMessageId: lastId },
        })

        console.log(`[Worker] Album processed: ${sorted.length} messages, text: ${text ? "yes" : "no"}, media: ${mediaUrls.length}`)
      } catch (error) {
        console.error("[Worker] Error handling album:", error)
      }
    },
    new Album({ chats: [BigInt(channelId) as any] })
  )

  // Single message handler — skip album messages (handled by Album event above)
  client.addEventHandler(
    async (event: any) => {
      try {
        const message = event.message
        if (!message) return

        // Album messages are handled by the Album event handler
        if (message.groupedId) return

        // Download media and resolve post URL in parallel
        const [telegramPostUrl, mediaResult] = await Promise.all([
          resolveTelegramPostUrl(client, message),
          downloadMessageMedia(client, message, channelUsername),
        ])

        const text = extractTextWithEntityUrls(message) ?? extractPollText(message)

        const grouped: GroupedMessage = {
          messageIds: [message.id],
          primaryMessageId: message.id,
          text,
          mediaUrls: mediaResult.url ? [mediaResult.url] : [],
          thumbnailUrl:
            mediaResult.thumbUrl ?? (mediaResult.type === "photo" ? mediaResult.url : null),
          groupedId: null,
          date: message.date,
          telegramPostUrl,
        }

        await ingestMessage(grouped, userId, channelId)

        // Update last message ID
        await db.userSettings.update({
          where: { userId },
          data: { storyLastMessageId: message.id },
        })
      } catch (error) {
        console.error("[Worker] Error handling message:", error)
      }
    },
    new NewMessage({ chats: [BigInt(channelId) as any], incoming: true, outgoing: true })
  )

  console.log(`[Worker] GramJS listener active for channel ${channelId}`)

  // Catch-up on startup (spec requirement 2.5.5)
  await catchUpMessages(client, channelId, channelUsername, userId, userSettings.storyLastMessageId)

  // Start connection watchdog (detects silent disconnects)
  startConnectionWatchdog()

  // Start periodic gap scan (detects messages lost during disconnect windows)
  startGapScan()

  // If the lock was lost during warm-up or catch-up, this client must not be
  // reported as a live session.
  if (!gramjsLock.isOwned()) throw new GramJSLockUnavailableError()

  isReconnecting = false
  return "connected"
  } catch (error) {
    // Nothing may survive a failed setup: no client retrying with the same
    // auth key, no held lock, no stale session references.
    gramjsClient = null
    workerChannelId = null
    workerChannelUsername = null
    workerUserId = null
    healthCheck.setGramjsConnected(false)
    const destroyed = await disposeGramJSSession({
      destroyClient: () => destroyTelegramClient(client, DESTROY_TIMEOUT_MS),
      releaseLock: () => gramjsLock.release(),
      onDestroyFailed: () => {
        console.error("[Worker] GramJS client survived its destroy — exiting to kill the orphan")
        process.exit(1)
      },
    })
    if (destroyed && error instanceof GramJSClientDestroyError) {
      // The destroy succeeded on the second attempt; this is now an ordinary
      // setup failure, not an orphan hazard.
      throw new Error("GramJS client failed to connect (destroy recovered on retry)")
    }
    throw error
  }
}

/**
 * Drop the live client and every reference to it. Runs before each restart —
 * a client must never outlive the lock that authorized it.
 */
async function teardownGramJS(): Promise<void> {
  isReconnecting = true
  const client = gramjsClient
  gramjsClient = null
  workerChannelId = null
  workerChannelUsername = null
  workerUserId = null
  healthCheck.setGramjsConnected(false)
  if (client) {
    const destroyed = await destroyTelegramClient(client, DESTROY_TIMEOUT_MS)
    if (!destroyed) {
      // A client that cannot be destroyed may keep reconnecting with the same
      // auth key; only process death ends it for certain.
      console.error("[Worker] GramJS client survived its destroy during restart — exiting to kill the orphan")
      process.exit(1)
    }
    console.log("[Worker] GramJS client destroyed")
  }
}

// ---------------------------------------------------------------------------
// Gap scan timer
// ---------------------------------------------------------------------------

function startGapScan(): void {
  if (gapScanInterval) return

  gapScanInterval = setInterval(async () => {
    if (!gramjsClient || !workerChannelId || !workerChannelUsername || !workerUserId || isReconnecting) return

    const client = gramjsClient
    const channelId = workerChannelId
    const channelUn = workerChannelUsername
    const userId = workerUserId

    const deps: GapScanDeps = {
      getMessages: async (limit: number) => {
        const entity = await client.getEntity(BigInt(channelId))
        const messages = await client.getMessages(entity, { limit })
        // Convert to TelegramMessage format (same as catch-up)
        return messages.reverse().map((msg: any) => ({
          messageId: msg.id,
          groupedId: msg.groupedId?.toString() ?? null,
          text: extractTextWithEntityUrls(msg) ?? extractPollText(msg),
          mediaUrl: null, // media downloaded separately
          date: msg.date,
          telegramPostUrl: null, // resolved separately
        }))
      },
      findExistingExternalIds: async (externalIds: string[]) => {
        const existing = await db.inboxItem.findMany({
          where: { externalId: { in: externalIds } },
          select: { externalId: true },
        })
        return new Set(existing.map((e) => e.externalId))
      },
      downloadMedia: async (messages, channelUsername) => {
        // Reconstruct raw GramJS messages for media download
        // Gap scan messages are TelegramMessage format; we need the raw message for downloadMediaBatch
        // For now, return null URLs — gap scan primarily ensures items are ingested;
        // media can be fetched in the pipeline's content extraction step
        return messages.map(() => ({ url: null }))
      },
      resolveTelegramPostUrls: async (messages) => {
        return messages.map(() => null)
      },
      ingestMessage,
    }

    await runGapScan(channelId, channelUn, userId, deps, { isReconnecting, gramjsClient })

    // Retry Telegram deletion for saved posts whose post-save attempt failed.
    // Only for the worker's own channel, only while this client is still live.
    if (telegramSweepRunning) return
    telegramSweepRunning = true
    try {
      const userSettings = await db.userSettings.findUnique({ where: { userId } })
      if (userSettings && userSettings.storyInboxChannelId === channelId && !isReconnecting && gramjsClient === client) {
        await sweepUndeletedTelegramMessages({
          db: {
            inboxItem: {
              findMany: (args) => db.inboxItem.findMany(args),
              findUnique: (args) => db.inboxItem.findUnique(args),
              update: (args) => db.inboxItem.update(args),
            },
          },
          gramjsClient: client,
          channelId,
          userId,
          autoDeleteEnabled: userSettings.autoDeleteTelegramMessages ?? false,
          shouldAbort: () => isReconnecting || gramjsClient !== client,
        })
      }
    } catch (error) {
      console.warn("[Worker] Telegram deletion sweep error:", error)
    } finally {
      telegramSweepRunning = false
    }
  }, GAP_SCAN_INTERVAL_MS)

  console.log("[Worker] Gap scan started (5-min interval)")
}

function stopGapScan(): void {
  if (gapScanInterval) {
    clearInterval(gapScanInterval)
    gapScanInterval = null
  }
}

// ---------------------------------------------------------------------------
// Self-filling collections sweep timer
// ---------------------------------------------------------------------------
//
// Trailing-edge debounce for self-filling collections ("tracked questions"):
// when a backing Parallel monitor brings in new APPROVED material, the webhook
// marks the collection's autoSynthAt; this sweep regenerates the living answer
// off the request path once the debounce window has elapsed. Independent of
// GramJS — it only touches Postgres + the synthesis LLM, so it runs even when
// the Telegram listener is down.

// The cadence freshness floor is the slow safety net (catches missed arms +
// first synthesis); it needn't run every 2-min tick. Throttle its (cheap but
// per-collection) material probes to roughly this interval to avoid scanning
// every idle tracked question on every sweep.
const SELF_FILLING_FLOOR_INTERVAL_MS = parseInt(process.env.SELF_FILLING_FLOOR_INTERVAL_MS || "900000", 10) // 15 min
let lastFloorSweepAt = 0
let selfFillingSweepRunning = false

function startSelfFillingSweep(): void {
  if (selfFillingSweepInterval) return

  selfFillingSweepInterval = setInterval(async () => {
    // Skip if a previous tick is still running (a big regen burst can exceed the
    // interval) so ticks don't overlap and double-process.
    if (selfFillingSweepRunning) return
    selfFillingSweepRunning = true
    try {
      // Independently guarded so one self-filling sub-pass can't starve the others
      // (e.g. a routing failure must not skip the Slice-1 regen sweep).

      // Route relevant existing-feed materials into tracked questions FIRST so a
      // freshly-routed match can arm the regen in the same tick (the debounce then
      // fires it a few minutes later).
      try {
        const { routed } = await routeRecentMaterials()
        if (routed > 0) {
          console.log(`[Worker] Self-filling routing: routed ${routed} material(s) into tracked questions`)
        }
      } catch (err) {
        console.error("[Worker] Self-filling routing failed (non-fatal):", err)
      }

      try {
        const now = Date.now()
        const includeFloor = now - lastFloorSweepAt >= SELF_FILLING_FLOOR_INTERVAL_MS
        if (includeFloor) lastFloorSweepAt = now
        const { regenerated, considered } = await sweepDueCollections(now, { includeFloor })
        if (regenerated > 0) {
          console.log(`[Worker] Self-filling sweep: regenerated ${regenerated}/${considered} living answer(s)`)
        }
      } catch (err) {
        console.error("[Worker] Self-filling sweep failed (non-fatal):", err)
      }

      try {
        await reconcileOrphanMonitors()
      } catch (err) {
        console.error("[Worker] Orphan-monitor reconcile failed (non-fatal):", err)
      }

      // RAD-323: pause monitors of lapsed owners / re-arm tracked questions when
      // access returns. Guarded like the other sub-passes so it can't starve them.
      try {
        const { paused, resumed } = await reconcileMonitorsForAccess()
        if (paused > 0 || resumed > 0) {
          console.log(`[Worker] Access-monitor reconcile: paused ${paused}, resumed ${resumed}`)
        }
      } catch (err) {
        console.error("[Worker] Access-monitor reconcile failed (non-fatal):", err)
      }
    } finally {
      selfFillingSweepRunning = false
    }
  }, SELF_FILLING_SWEEP_INTERVAL_MS)

  console.log(`[Worker] Self-filling sweep started (${Math.round(SELF_FILLING_SWEEP_INTERVAL_MS / 1000)}s interval)`)
}

function stopSelfFillingSweep(): void {
  if (selfFillingSweepInterval) {
    clearInterval(selfFillingSweepInterval)
    selfFillingSweepInterval = null
  }
}

// ---------------------------------------------------------------------------
// Catch-up logic
// ---------------------------------------------------------------------------

async function catchUpMessages(
  client: any,
  channelId: string,
  channelUsername: string,
  userId: string,
  lastMessageId: number | null
): Promise<void> {
  if (!lastMessageId) {
    console.log("[Worker] No lastMessageId — skipping catch-up")
    return
  }

  console.log(`[Worker] Catching up from message ${lastMessageId} (max ${CATCH_UP_LIMIT})`)

  try {
    const { Api } = await import("telegram")
    const entity = await client.getEntity(BigInt(channelId))
    // Buffer: go back 20 messages to avoid splitting albums at the boundary.
    // Telegram albums can have up to 10 items, so 20 is a safe margin.
    // The dedup check in ingestMessage() prevents re-processing.
    const bufferMinId = Math.max(0, lastMessageId - 20)
    const messages = await client.getMessages(entity, {
      limit: CATCH_UP_LIMIT,
      minId: bufferMinId,
    })

    console.log(`[Worker] Found ${messages.length} messages to catch up`)

    // Feed all messages to the album grouper WITHOUT awaiting each one.
    // Awaiting sequentially would break album grouping: each message would
    // block for 10s debounce, flush alone, and miss the rest of the album.
    const reversed = messages.reverse()

    // Resolve telegram post URLs and download media in parallel
    const [telegramPostUrls, mediaResults] = await Promise.all([
      Promise.all(reversed.map((msg: any) => resolveTelegramPostUrl(client, msg))),
      downloadMediaBatch(client, reversed, channelUsername),
    ])

    const addPromises: Promise<GroupedMessage | null>[] = []
    for (let i = 0; i < reversed.length; i++) {
      const message = reversed[i]
      const text = extractTextWithEntityUrls(message) ?? extractPollText(message)
      const tgMessage: TelegramMessage = {
        messageId: message.id,
        groupedId: message.groupedId?.toString() ?? null,
        text,
        mediaUrl: mediaResults[i].url,
        thumbUrl: mediaResults[i].thumbUrl,
        date: message.date,
        telegramPostUrl: telegramPostUrls[i],
      }
      addPromises.push(albumGrouper.add(tgMessage))
    }

    // Flush all pending album groups immediately (resolves promises)
    albumGrouper.flushAll()

    // Process only non-null results (one per group, duplicates filtered out)
    // Skip messages older than the cutoff date
    const groupedMessages = await Promise.all(addPromises)
    for (const grouped of groupedMessages) {
      if (grouped && grouped.date >= GAP_SCAN_CUTOFF_TS) {
        await ingestMessage(grouped, userId, channelId)
      }
    }

    if (messages.length > 0) {
      const lastId = messages[messages.length - 1].id // After reverse, newest is last
      await db.userSettings.update({
        where: { userId },
        data: { storyLastMessageId: lastId },
      })
    }

    console.log("[Worker] Catch-up complete")
  } catch (error) {
    console.error("[Worker] Error during catch-up:", error)
    console.warn("[Worker] Catch-up failed — messages from the disconnect window may be lost")
  }
}

// ---------------------------------------------------------------------------
// Connection watchdog — detects silent GramJS disconnects & auto-reconnects
// ---------------------------------------------------------------------------

function startConnectionWatchdog(): void {
  if (watchdogInterval) return

  console.log(`[Watchdog] Started (ping every ${WATCHDOG_INTERVAL_MS / 1000}s)`)

  watchdogInterval = setInterval(async () => {
    if (!gramjsClient || isReconnecting) return

    try {
      // Timeout prevents hanging on half-open TCP sockets (common on Railway)
      await Promise.race([
        gramjsClient.getMe(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Ping timeout")), PING_TIMEOUT_MS)
        ),
      ])
      // Ping succeeded — connection is alive
    } catch (error) {
      console.error("[Watchdog] Ping failed, connection lost:", error)
      healthCheck.setGramjsConnected(false)
      // The lifecycle owns the restart: it queues the request if another pass
      // is in flight (a dropped restart is how the worker used to end up with
      // no client and a green watchdog message).
      void gramjsLifecycle.requestRestart("watchdog ping failed")
    }
  }, WATCHDOG_INTERVAL_MS)
}

function stopConnectionWatchdog(): void {
  if (watchdogInterval) {
    clearInterval(watchdogInterval)
    watchdogInterval = null
    console.log("[Watchdog] Stopped")
  }
}

// ---------------------------------------------------------------------------
// Health check HTTP server
// ---------------------------------------------------------------------------

/** Write a telegram-proxy answer: JSON for an object body, plain text for a string. */
function writeProxyAnswer(res: http.ServerResponse, answer: { status: number; body: unknown }): void {
  if (typeof answer.body === "string") {
    res.writeHead(answer.status)
    res.end(answer.body)
  } else {
    res.writeHead(answer.status, { "Content-Type": "application/json" })
    res.end(JSON.stringify(answer.body))
  }
}

function startHealthServer(): void {
  httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${HEALTH_PORT}`)

    if (url.pathname === "/health" && req.method === "GET") {
      // Check DB
      try {
        await db.$queryRaw`SELECT 1`
        healthCheck.setDatabaseReachable(true)
      } catch {
        healthCheck.setDatabaseReachable(false)
      }

      // Count pending items
      try {
        const count = await db.inboxItem.count({ where: { status: "PENDING" } })
        healthCheck.setPendingItems(count)
      } catch {
        // Ignore
      }

      // How long this worker has been waiting for a peer to release the
      // session lock — the difference between a deploy handover and a broken
      // worker, both of which report gramjs: false.
      healthCheck.setLockWaitSeconds(gramjsLifecycle.lockWaitSeconds())

      const status = healthCheck.getStatus()
      const httpStatus = healthHttpStatus(status.status)
      res.writeHead(httpStatus, { "Content-Type": "application/json" })
      res.end(JSON.stringify(status))
    }
    // -----------------------------------------------------------------------
    // Telegram proxy endpoints — used by Next.js source parser to avoid
    // AUTH_KEY_DUPLICATED from creating a second GramJS client
    // -----------------------------------------------------------------------
    else if (url.pathname === "/telegram/session-check" && req.method === "GET") {
      // `valid` is kept for existing callers; `state` distinguishes "not
      // connected because we are waiting/connecting" from a dead session.
      const state = gramjsLifecycle.state()
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ valid: state === "active", state }))
    }
    else if (url.pathname === "/telegram/channel-info" && req.method === "GET") {
      const username = url.searchParams.get("username")
      if (!username) {
        res.writeHead(400)
        res.end("Missing username parameter")
        return
      }
      if (!gramjsClient || isReconnecting) {
        res.writeHead(503)
        res.end("GramJS client not available")
        return
      }

      const includePhoto = url.searchParams.get("includePhoto") === "true"
      writeProxyAnswer(res, await channelInfo(gramjsClient, username, includePhoto))
    }
    else if (url.pathname === "/telegram/reconnect" && req.method === "POST") {
      // Called after Telegram re-authentication to pick up the new session.
      // Routed through the lifecycle: one pass at a time, lock re-acquired,
      // and no "success" response when the session is still bad.
      console.log("[Worker] /telegram/reconnect — re-reading session from DB...")
      try {
        await gramjsLifecycle.requestRestart("telegram re-auth")
        const state = gramjsLifecycle.state()
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ success: state === "active", state }))
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[Worker] /telegram/reconnect failed: ${msg}`)
        if (!res.headersSent) res.writeHead(500)
        res.end(msg)
      }
    }
    else if (url.pathname === "/telegram/parse-channel" && req.method === "POST") {
      try {
        const body = await new Promise<string>((resolve, reject) => {
          let data = ""
          req.on("data", (chunk: Buffer) => { data += chunk.toString() })
          req.on("end", () => resolve(data))
          req.on("error", reject)
        })
        const payload = JSON.parse(body)
        if (payload?.channelUsername && (!gramjsClient || isReconnecting)) {
          res.writeHead(503)
          res.end("GramJS client not available")
          return
        }
        writeProxyAnswer(res, await parseChannelResponse(gramjsClient, payload ?? {}))
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[Worker] /telegram/parse-channel error: ${msg}`)
        if (!res.headersSent) res.writeHead(500)
        res.end(msg)
      }
    }
    else {
      res.writeHead(404)
      res.end("Not Found")
    }
  })

  httpServer.listen(HEALTH_PORT, () => {
    console.log(`[Worker] Health check server on port ${HEALTH_PORT}`)
  })
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

async function shutdown(signal: string): Promise<void> {
  console.log(`[Worker] Received ${signal}, shutting down gracefully...`)

  // Hard timeout: ensure we exit before Railway SIGKILL (default drain = 10s)
  const SHUTDOWN_TIMEOUT_MS = 8_000
  setTimeout(() => {
    console.error(`[Worker] Shutdown timeout (${SHUTDOWN_TIMEOUT_MS}ms), forcing exit`)
    process.exit(1)
  }, SHUTDOWN_TIMEOUT_MS).unref()

  // 1. Destroy GramJS FIRST — critical to prevent AUTH_KEY_DUPLICATED during
  //    deploys. Order is load-bearing and owned by disposeGramJSSession:
  //    client destroyed → lock released. Never the other way round.
  await gramjsLifecycle.stop(2_000) // halt retry loops before touching the client
  const client = gramjsClient
  gramjsClient = null
  await disposeGramJSSession({
    // Must be << SHUTDOWN_TIMEOUT_MS to leave room for the flush below.
    destroyClient: () => destroyTelegramClient(client, 3_000),
    releaseLock: () => gramjsLock.stop(),
    onDestroyFailed: () => {
      // Keep the lock: session death will release it, and exiting now kills
      // the orphan that a released lock would otherwise let duplicate.
      console.error("[Worker] GramJS client survived its shutdown destroy — exiting without releasing the lock")
      process.exit(1)
    },
  })
  healthCheck.setGramjsConnected(false)

  // 2. Stop monitors (watchdog may log one stale error if mid-ping during destroy — harmless)
  isReconnecting = true // guard every GramJS consumer while the process winds down
  stopConnectionWatchdog()
  stopGapScan()
  stopSelfFillingSweep()
  retryDaemon.stop()

  // 3. Flush processing queue
  await processingQueue.shutdown()

  // 4. Flush album grouper
  albumGrouper.flushAll()

  // 5. Close health server
  if (httpServer) {
    httpServer.close()
  }

  // 6. Disconnect Prisma (the lock's pinned connection was closed when the
  //    lock was released in step 1)
  await db.$disconnect()

  console.log("[Worker] Shutdown complete")
  process.exit(0)
}

process.on("SIGTERM", () => shutdown("SIGTERM"))
process.on("SIGINT", () => shutdown("SIGINT"))

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("[Worker] Story Aggregator Worker starting...")

  // Start health check server
  startHealthServer()

  // Check DB connectivity
  try {
    await db.$queryRaw`SELECT 1`
    healthCheck.setDatabaseReachable(true)
    console.log("[Worker] Database connected")
  } catch (error) {
    console.error("[Worker] Database connection failed:", error)
    healthCheck.setDatabaseReachable(false)
  }

  // Start the self-filling collections sweep. It only touches Postgres + the
  // synthesis LLM, so it runs independently of GramJS — kick it off before the
  // deploy-overlap delay so tracked-question answers stay fresh even if the
  // Telegram listener never comes up.
  startSelfFillingSweep()

  // Start the retry daemon BEFORE the GramJS startup sequence: during a deploy
  // overlap the session lock can be held for minutes, and ERROR-item retries
  // must not stop while we wait for a peer to release it.
  retryDaemon.start(db as any)
  console.log("[Worker] Retry daemon started (15-min interval)")

  // Heartbeat monitor disabled — daily reports were being sent to the inbox
  // channel and re-processed as stories. The reports are not needed.
  // HeartbeatMonitor class and heartbeat.ts are kept for potential future use
  // with a dedicated chat ID (STORY_HEARTBEAT_CHAT_ID).
  console.log("[Worker] Heartbeat monitor disabled")

  // Delay GramJS connection on startup to avoid AUTH_KEY_DUPLICATED during
  // Railway rolling deploys. The old container's GramJS client may still be
  // connected when this new container starts — two clients with the same session
  // cause Telegram to permanently invalidate the session key.
  // The delay gives the old container time to receive SIGTERM and disconnect;
  // the session lock and its settle window cover the remaining overlap.
  const raw = parseInt(process.env.GRAMJS_STARTUP_DELAY_MS || "30000", 10)
  const GRAMJS_STARTUP_DELAY_MS = Number.isNaN(raw) ? 30000 : raw
  console.log(`[Worker] Waiting ${GRAMJS_STARTUP_DELAY_MS / 1000}s before connecting GramJS (deploy overlap guard)...`)
  await new Promise(r => setTimeout(r, GRAMJS_STARTUP_DELAY_MS))

  // The lifecycle owns the retry policy: lock-waits retry forever (a live peer
  // is normal), transient failures are bounded, AUTH_KEY_DUPLICATED is final
  // until the operator re-authenticates.
  await gramjsLifecycle.start()

  console.log("[Worker] Story Aggregator Worker ready")
}

main().catch((error) => {
  console.error("[Worker] Fatal error:", error)
  process.exit(1)
})
