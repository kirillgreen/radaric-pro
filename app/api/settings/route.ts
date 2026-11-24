import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { requireAdmin, isErrorResponse } from "@/lib/auth-utils"
import { sanitizeModelId, sanitizeReasoningEffort } from "@/lib/models/registry"

// GET /api/settings - Get global settings (admin only)
export async function GET() {
  try {
    const authResult = await requireAdmin()
    if (isErrorResponse(authResult)) return authResult

    let settings = await db.settings.findFirst()

    // Create settings record if it doesn't exist
    if (!settings) {
      settings = await db.settings.create({
        data: {
          aiModel: null,
          aiTemperature: 0.7,
          telegramApiId: null,
          telegramApiHash: null,
          telegramSessionString: null,
          telegramPhoneNumber: null,
        },
      })
      console.log('Created initial settings record')
    }

    return NextResponse.json(settings)
  } catch (error) {
    console.error("Error fetching settings:", error)
    return NextResponse.json(
      { error: "Failed to fetch settings" },
      { status: 500 }
    )
  }
}

// PUT /api/settings - Update global settings (admin only)
export async function PUT(request: Request) {
  try {
    const authResult = await requireAdmin()
    if (isErrorResponse(authResult)) return authResult

    const body = await request.json()
    console.log('PUT /api/settings - received body:', {
      ...body,
      telegramApiHash: body.telegramApiHash ? '***' : null,
      aiApiKey: body.aiApiKey ? '***' : null,
    })

    // Check if settings exist
    const existingSettings = await db.settings.findFirst()

    let settings
    if (existingSettings) {
      settings = await db.settings.update({
        where: { id: existingSettings.id },
        data: {
          // AI settings
          aiTemperature: body.aiTemperature,
          aiApiKey: body.aiApiKey,
          // Per-stage overrides. Absent key = leave alone (Prisma ignores
          // undefined); explicit null or an unlisted id = clear the override and
          // fall back to the stage default.
          ...(body.aiModel !== undefined && {
            aiModel: sanitizeModelId(body.aiModel),
          }),
          ...(body.synthesisModel !== undefined && {
            synthesisModel: sanitizeModelId(body.synthesisModel),
          }),
          ...(body.discoveryModel !== undefined && {
            discoveryModel: sanitizeModelId(body.discoveryModel),
          }),
          ...(body.filterReasoningEffort !== undefined && {
            filterReasoningEffort: sanitizeReasoningEffort(body.filterReasoningEffort),
          }),
          // Telegram settings
          telegramApiId: body.telegramApiId,
          telegramApiHash: body.telegramApiHash,
          telegramSessionString: body.telegramSessionString,
          telegramPhoneNumber: body.telegramPhoneNumber,
          // Parallel settings
          parallelApiKey: body.parallelApiKey,
          parallelWebhookSecret: body.parallelWebhookSecret,
        },
      })
    } else {
      settings = await db.settings.create({
        data: {
          aiModel: sanitizeModelId(body.aiModel),
          aiTemperature: body.aiTemperature || 0.7,
          aiApiKey: body.aiApiKey,
          synthesisModel: sanitizeModelId(body.synthesisModel),
          discoveryModel: sanitizeModelId(body.discoveryModel),
          filterReasoningEffort: sanitizeReasoningEffort(body.filterReasoningEffort),
          telegramApiId: body.telegramApiId,
          telegramApiHash: body.telegramApiHash,
          telegramSessionString: body.telegramSessionString,
          telegramPhoneNumber: body.telegramPhoneNumber,
          parallelApiKey: body.parallelApiKey,
          parallelWebhookSecret: body.parallelWebhookSecret,
        },
      })
    }

    console.log('PUT /api/settings - saved settings:', {
      ...settings,
      telegramApiHash: settings.telegramApiHash ? '***' : null,
      aiApiKey: settings.aiApiKey ? '***' : null,
    })

    return NextResponse.json(settings)
  } catch (error) {
    console.error("Error updating settings:", error)
    return NextResponse.json(
      { error: "Failed to update settings" },
      { status: 500 }
    )
  }
}
