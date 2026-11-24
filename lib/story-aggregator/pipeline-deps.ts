/**
 * Shared factory for PipelineDeps — used by both poll API route and
 * the materials → stories API route.
 *
 * Model selection and construction come from lib/models/; this file
 * only decides WHICH stage each dep serves.
 */

import { db } from "@/lib/db"
import type { PipelineDeps } from "./pipeline"
import { extractContentFromUrl, extractContentFromText } from "./content-extractor"
import { matchItem as matchItemFn, type StoryMatcherDeps } from "./story-matcher"
import { findRelatedMaterials, type ArchiveLinkerDeps } from "./archive-linker"
import { replaceNotionPageContent } from "./notion-page-update"
import { requiresAnthropicKey, buildProviderOptions } from "@/lib/models/registry"
import { resolveRuntimeModelForStage } from "@/lib/models/runtime"
import { storyOverridesFor, type SettingsShaper, type StorySettingsRow } from "./story-entitlement"
import { createModelInstance } from "@/lib/models/provider"
import {
  STORY_GENERATION_TIMEOUT_MS,
  STORY_MATCHING_TIMEOUT_MS,
  STORY_AI_MAX_RETRIES,
} from "./ai-limits"

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** The `userSettings.findUnique` dep, shaped before the pipeline sees the row. */
function buildSettingsReader(shapeSettings: SettingsShaper) {
  return async (args: { where: { userId: string } }) => {
    const row = await db.userSettings.findUnique(args as never)
    return shapeSettings(row as StorySettingsRow | null) as never
  }
}

/** Prisma-wrapped db slice shared by all pipeline dep factories. */
function buildSharedDb(shapeSettings: SettingsShaper): PipelineDeps["db"] {
  return {
    inboxItem: {
      findUnique: (args) => db.inboxItem.findUnique(args as never) as never,
      update: (args) => db.inboxItem.update(args as never),
      updateMany: (args) => db.inboxItem.updateMany(args as never),
    },
    story: {
      create: (args) => db.story.create(args as never),
      findUnique: (args) => db.story.findUnique(args as never) as never,
      update: (args) => db.story.update(args as never),
    },
    userSettings: {
      findUnique: buildSettingsReader(shapeSettings),
      update: (args) => db.userSettings.update(args as never),
    },
  }
}

/** Notion page-create helper shared by both pipeline dep factories. */
function buildNotionSaver(notionToken: string): PipelineDeps["saveToNotion"] {
  return async (databaseId, properties, blocks) => {
    if (!notionToken) {
      throw new Error("Notion token not configured")
    }
    const { Client } = await import("@notionhq/client")
    const notion = new Client({ auth: notionToken })

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
  }
}

// ---------------------------------------------------------------------------
// buildPipelineDeps
// ---------------------------------------------------------------------------

export async function buildPipelineDeps(
  userId: string,
  notionToken: string
): Promise<PipelineDeps> {
  // Fetch settings for model resolution and API key. The role decides whether
  // a stored story override may be used at all (RAD-369).
  const [settings, userSettings, user] = await Promise.all([
    db.settings.findFirst(),
    db.userSettings.findUnique({ where: { userId } }),
    db.user.findUnique({ where: { id: userId }, select: { role: true } }),
  ])
  const overrides = storyOverridesFor(user?.role)

  // Resolve FIRST, then demand a credential — and only the credential the
  // resolved models actually use. This used to throw on a missing Anthropic key
  // even when both stages had been moved to OpenRouter slugs, which made every
  // story run hostage to a key it no longer touched.
  const writerModel = resolveRuntimeModelForStage("storyWriter", overrides.model(userSettings?.storyWriterModel))
  const matcherModel = resolveRuntimeModelForStage("storyMatcher", overrides.model(userSettings?.storyMatcherModel))

  const anthropicApiKey = settings?.aiApiKey || process.env.ANTHROPIC_API_KEY
  if (!anthropicApiKey && [writerModel, matcherModel].some(requiresAnthropicKey)) {
    throw new Error("ANTHROPIC_API_KEY not configured (neither in settings nor env)")
  }

  // Reasoning effort, resolved once per factory rather than per call — it is a
  // property of the model, and both deps below run in a loop.
  const writerOptions = buildProviderOptions(writerModel)
  const matcherOptions = buildProviderOptions(matcherModel)

  return {
    db: buildSharedDb(overrides.settings),
    generateStory: async (systemPrompt: string, userContent: string) => {
      const { generateObject } = await import("ai")
      const { StoryOutputSchema } = await import("@/lib/story-aggregator/schemas")
      const model = await createModelInstance(writerModel, { anthropicApiKey })
      const result = await generateObject({
        model,
        schema: StoryOutputSchema,
        system: systemPrompt,
        prompt: userContent,
        abortSignal: AbortSignal.timeout(STORY_GENERATION_TIMEOUT_MS),
        maxRetries: STORY_AI_MAX_RETRIES,
        ...(writerOptions ? { providerOptions: writerOptions } : {}),
      })
      return result.object
    },
    saveToNotion: buildNotionSaver(notionToken),
    updateNotionPage: async (pageId, properties, blocks) => {
      if (!notionToken) {
        throw new Error("Notion token not configured")
      }
      const { Client } = await import("@notionhq/client")
      const notion = new Client({ auth: notionToken })

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
          story: { findMany: (args) => db.story.findMany(args as never) },
          inboxItem: { findUnique: (args) => db.inboxItem.findUnique(args as never) as never },
        },
        matchWithAI: async (systemPrompt, userContent) => {
          const { generateText } = await import("ai")
          const model = await createModelInstance(matcherModel, { anthropicApiKey })
          const result = await generateText({
            model,
            system: systemPrompt,
            prompt: userContent,
            abortSignal: AbortSignal.timeout(STORY_MATCHING_TIMEOUT_MS),
            maxRetries: STORY_AI_MAX_RETRIES,
            ...(matcherOptions ? { providerOptions: matcherOptions } : {}),
          })
          // Extract JSON from response — models often wrap in ```json ... ``` blocks
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
// buildMaterialStoryDeps (MaterialPipelineDeps shape — for processApprovedMaterials)
// ---------------------------------------------------------------------------

import { matchContent } from "./story-matcher"
import type { MaterialPipelineDeps } from "./material-story-pipeline"

export async function buildMaterialStoryDeps(userId: string): Promise<MaterialPipelineDeps> {
  const [settings, userSettings, user] = await Promise.all([
    db.settings.findFirst(),
    db.userSettings.findUnique({ where: { userId } }),
    db.user.findUnique({ where: { id: userId }, select: { role: true } }),
  ])
  const overrides = storyOverridesFor(user?.role)
  const materialModel = resolveRuntimeModelForStage(
    "materialStory",
    overrides.model(userSettings?.materialStoryModel)
  )
  const anthropicApiKey = settings?.aiApiKey || process.env.ANTHROPIC_API_KEY
  const materialOptions = buildProviderOptions(materialModel)

  return {
    db: {
      material: {
        findMany: (args) => db.material.findMany(args as never) as never,
        update: (args) => db.material.update(args as never),
        updateMany: (args) => db.material.updateMany(args as never),
      },
      story: {
        create: (args) => db.story.create(args as never),
        findMany: (args) => db.story.findMany(args as never),
        findUnique: (args) => db.story.findUnique(args as never) as never,
        update: (args) => db.story.update(args as never),
      },
      userSettings: {
        findUnique: buildSettingsReader(overrides.settings),
      },
      $transaction: ((fn: (tx: unknown) => unknown) =>
        db.$transaction((tx) =>
          fn({
            story: { create: (args: never) => tx.story.create(args) },
            material: { updateMany: (args: never) => tx.material.updateMany(args) },
          }) as Promise<unknown>
        )) as MaterialPipelineDeps["db"]["$transaction"],
    },
    matchContent: matchContent as MaterialPipelineDeps["matchContent"],
    generateStory: async (systemPrompt: string, userContent: string) => {
      const { generateObject } = await import("ai")
      const { StoryOutputSchema } = await import("@/lib/story-aggregator/schemas")
      const result = await generateObject({
        model: await createModelInstance(materialModel, { anthropicApiKey }),
        schema: StoryOutputSchema,
        system: systemPrompt,
        prompt: userContent,
        abortSignal: AbortSignal.timeout(STORY_GENERATION_TIMEOUT_MS),
        maxRetries: STORY_AI_MAX_RETRIES,
        ...(materialOptions ? { providerOptions: materialOptions } : {}),
      })
      return result.object
    },
    matchWithAI: async (systemPrompt: string, userContent: string) => {
      const { generateText } = await import("ai")
      const result = await generateText({
        model: await createModelInstance(materialModel, { anthropicApiKey }),
        system: systemPrompt,
        prompt: userContent,
        abortSignal: AbortSignal.timeout(STORY_MATCHING_TIMEOUT_MS),
        maxRetries: STORY_AI_MAX_RETRIES,
        ...(materialOptions ? { providerOptions: materialOptions } : {}),
      })
      // Extract JSON from response — models often wrap in ```json ... ``` blocks
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
}
