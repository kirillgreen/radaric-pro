import { generateObject } from "ai"
import { z } from "zod"
import { db } from "@/lib/db"
import { createModel } from "@/lib/ai"
import { buildProviderOptions } from "@/lib/models/registry"
import { resolveRuntimeModelForStage } from "@/lib/models/runtime"
import { isHtml } from "@/lib/html-utils"
import { stripHtml } from "@/lib/sanitize"

const SYNTHESIS_SCHEMA = z.object({
  synthesis: z.string().describe("The full updated answer as markdown, with inline [n] citations and a ## Sources list."),
  whatChanged: z.string().describe("1-3 sentences: what's new vs the previous answer (or 'First synthesis.')."),
})

const MAX_SOURCES = 30
const MAX_SOURCE_CHARS = 1500
const SYNTHESIS_TIMEOUT_MS = 90_000

const COOLDOWN_MS = 8_000

export type SynthesisResult =
  | { status: "ok"; synthesis: string; synthesisDelta: string; synthesisUpdatedAt: Date; sourceCount: number }
  | { status: "not_found" }
  | { status: "empty" }
  | { status: "cooldown" }

/**
 * (Re)generate a collection's living answer — a Karpathy-LLM-wiki-style cited
 * markdown page maintained from the collection's saved items + excerpts.
 * Provenance-first: every claim must carry an inline [n] citation.
 */
export async function regenerateSynthesis(userId: string, collectionId: string): Promise<SynthesisResult> {
  const collection = await db.collection.findFirst({
    where: { id: collectionId, userId },
    select: { id: true, name: true, query: true, synthesis: true, trackRequestedAt: true, synthesisUpdatedAt: true, monitorFeedId: true },
  })
  if (!collection) return { status: "not_found" }

  // Cooldown: this is a paid LLM call — refuse a rapid re-fire (accidental
  // double-click or a scripted loop) before doing any work.
  if (collection.synthesisUpdatedAt && Date.now() - collection.synthesisUpdatedAt.getTime() < COOLDOWN_MS) {
    return { status: "cooldown" }
  }

  const [savedItems, excerpts, autoMaterials, routedMaterials] = await Promise.all([
    db.savedItem.findMany({
      where: { userId, collectionId },
      orderBy: { createdAt: "desc" },
      take: MAX_SOURCES,
      select: { material: { select: { title: true, url: true, content: true } } },
    }),
    db.savedExcerpt.findMany({
      where: { userId, collectionId },
      orderBy: { createdAt: "desc" },
      take: MAX_SOURCES,
      select: { text: true, material: { select: { title: true, url: true } } },
    }),
    // Self-filling: the backing monitor feed's APPROVED materials feed the
    // answer alongside any manual saves.
    collection.monitorFeedId
      ? db.material.findMany({
          where: { sourceId: collection.monitorFeedId, aiEvaluation: "APPROVED", userStatus: { not: "DELETED" } },
          orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }],
          take: MAX_SOURCES,
          select: { title: true, url: true, content: true },
        })
      : Promise.resolve([]),
    // Self-filling (Slice 2): materials routed in from the user's normal feeds
    // because they matched this tracked question's query.
    collection.query
      ? db.collectionMaterial
          .findMany({
            where: { collectionId, material: { userStatus: { not: "DELETED" } } },
            orderBy: { createdAt: "desc" },
            take: MAX_SOURCES,
            select: { material: { select: { title: true, url: true, content: true } } },
          })
          .then((rows) => rows.map((r) => r.material))
      : Promise.resolve([]),
  ])

  const sources: Array<{ n: number; label: string; url: string; body: string }> = []
  for (const s of savedItems) {
    // Truncate the raw content BEFORE the sanitize pass so we never run
    // sanitize-html over a full large article just to keep the first 1500 chars.
    const raw = s.material.content.slice(0, MAX_SOURCE_CHARS * 4)
    const clean = isHtml(raw) ? stripHtml(raw) : raw
    sources.push({ n: sources.length + 1, label: s.material.title, url: s.material.url, body: clean.slice(0, MAX_SOURCE_CHARS) })
  }
  for (const ex of excerpts) {
    sources.push({ n: sources.length + 1, label: `Excerpt — ${ex.material.title}`, url: ex.material.url, body: ex.text.slice(0, MAX_SOURCE_CHARS) })
  }
  for (const m of [...autoMaterials, ...routedMaterials]) {
    if (sources.length >= MAX_SOURCES) break
    if (sources.some((src) => src.url === m.url)) continue // dedup against manual saves + backing-feed
    const raw = m.content.slice(0, MAX_SOURCE_CHARS * 4)
    const clean = isHtml(raw) ? stripHtml(raw) : raw
    sources.push({ n: sources.length + 1, label: m.title, url: m.url, body: clean.slice(0, MAX_SOURCE_CHARS) })
  }
  if (sources.length === 0) return { status: "empty" }

  const s = await db.settings.findFirst({
    select: { id: true, aiModel: true, aiApiKey: true, aiTemperature: true, synthesisModel: true },
  })
  const settings = s
    ? { id: s.id, aiModel: s.aiModel ?? "", aiApiKey: s.aiApiKey ?? "", aiTemperature: s.aiTemperature ?? 0.3 }
    : null
  // synthesisModel is this stage's own setting; null follows the stage default.
  // It used to borrow Settings.aiModel — the FILTERING model, tuned for throughput
  // on hundreds of short items a day, which is the wrong tier for this job.
  const modelId = resolveRuntimeModelForStage("synthesis", s?.synthesisModel)
  const model = await createModel(settings, { modelId })
  const providerOptions = buildProviderOptions(modelId)

  const sourcesBlock = sources
    .map((src) => `[${src.n}] ${src.label}\nURL: ${src.url}\n${src.body}`)
    .join("\n\n---\n\n")

  const prompt = `You maintain a living, cited answer to a tracked topic — a wiki page that stays current.

TOPIC: "${collection.query ?? collection.name}"

CURRENT ANSWER (empty on first run):
${collection.synthesis ?? "(none yet)"}

SOURCES the user saved (numbered — cite them inline as [n]):
${sourcesBlock}

Update the answer. Rules:
- Concise markdown (~200–400 words) synthesizing the CURRENT STATE of the topic from the sources.
- EVERY factual claim carries an inline citation [n] to a source above. No claim without a source.
- Open with a 1–2 sentence summary; use short sections or bullets where they help.
- End with a "## Sources" section listing [n] → the source title as a markdown link to its URL.
- Be honest: if sources conflict or are thin, say so. Never invent facts or sources.
- whatChanged: 1–3 sentences on what's new/different vs the current answer (or "First synthesis." on first run).`

  const result = await generateObject({
    model,
    schema: SYNTHESIS_SCHEMA,
    prompt,
    temperature: settings?.aiTemperature ?? 0.3,
    abortSignal: AbortSignal.timeout(SYNTHESIS_TIMEOUT_MS),
    maxRetries: 2,
    ...(providerOptions ? { providerOptions } : {}),
  })

  const updated = await db.collection.update({
    where: { id: collectionId },
    data: {
      synthesis: result.object.synthesis,
      synthesisDelta: result.object.whatChanged,
      synthesisUpdatedAt: new Date(),
      // Generating the answer is the strongest intent signal — record it too.
      trackRequestedAt: collection.trackRequestedAt ?? new Date(),
    },
    select: { synthesis: true, synthesisDelta: true, synthesisUpdatedAt: true },
  })

  return {
    status: "ok",
    synthesis: updated.synthesis ?? "",
    synthesisDelta: updated.synthesisDelta ?? "",
    synthesisUpdatedAt: updated.synthesisUpdatedAt ?? new Date(),
    sourceCount: sources.length,
  }
}
