import { db } from "@/lib/db"
import { getMissingModelSetting, resolveRuntimeModelForStage } from "@/lib/models/runtime"

/** The provider setting missing for the installation's filtering model, if any. */
export async function getMissingFilteringModelSetting() {
  const settings = await db.settings.findFirst({ select: { aiModel: true, aiApiKey: true } })
  const model = resolveRuntimeModelForStage("filtering", settings?.aiModel)
  return getMissingModelSetting(model, settings?.aiApiKey)
}
