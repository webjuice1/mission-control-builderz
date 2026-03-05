import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { MODEL_CATALOG, PROVIDER_LABELS, TIER_LABELS, TIER_COLORS, getModelsByProvider } from '@/lib/models'
import { runOpenClaw } from '@/lib/command'
import { logger } from '@/lib/logger'

/**
 * GET /api/models - Returns all available models grouped by provider.
 *
 * Merges the static MODEL_CATALOG with live data from `openclaw models`
 * to catch any models configured but not in the catalog.
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    // Start with catalog models
    const modelMap = new Map(MODEL_CATALOG.map(m => [m.name, m]))

    // Try to get live configured models from OpenClaw
    try {
      const { stdout } = await runOpenClaw(['models'], { timeoutMs: 8000 })

      // Parse "Configured models (N): model1, model2, ..."
      const configuredMatch = stdout.match(/Configured models\s*\(\d+\)\s*:\s*(.+)/i)
      if (configuredMatch) {
        const modelNames = configuredMatch[1].split(',').map(s => s.trim()).filter(Boolean)
        for (const name of modelNames) {
          if (!modelMap.has(name)) {
            // Infer provider from model name
            const provider = name.split('/')[0] || 'unknown'
            modelMap.set(name, {
              alias: name.split('/').pop() || name,
              name,
              provider,
              description: 'Configured in OpenClaw',
              costPer1k: 0,
              tier: 'standard',
            })
          }
        }
      }

      // Parse aliases
      const aliasMatch = stdout.match(/Aliases\s*\(\d+\)\s*:\s*(.+)/i)
      if (aliasMatch) {
        const aliasPairs = aliasMatch[1].split(',').map(s => s.trim())
        for (const pair of aliasPairs) {
          const [alias, modelName] = pair.split('->').map(s => s.trim())
          if (alias && modelName && modelMap.has(modelName)) {
            const model = modelMap.get(modelName)!
            model.alias = alias
          }
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Could not fetch live models from OpenClaw, using catalog only')
    }

    // Group by provider
    const allModels = Array.from(modelMap.values())
    const grouped: Record<string, typeof allModels> = {}
    for (const model of allModels) {
      if (!grouped[model.provider]) grouped[model.provider] = []
      grouped[model.provider].push(model)
    }

    // Sort: direct providers first, then copilot-proxy, then local
    const providerOrder = ['anthropic', 'openai-codex', 'xai', 'openrouter', 'minimax', 'copilot-proxy', 'ollama']
    const sortedProviders = Object.keys(grouped).sort((a, b) => {
      const ai = providerOrder.indexOf(a)
      const bi = providerOrder.indexOf(b)
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi)
    })

    const result = sortedProviders.map(provider => ({
      provider,
      label: PROVIDER_LABELS[provider] || provider,
      models: grouped[provider].map(m => ({
        name: m.name,
        alias: m.alias,
        description: m.description,
        costPer1k: m.costPer1k,
        tier: m.tier || 'standard',
        tierLabel: TIER_LABELS[m.tier || 'standard'] || '$$',
        tierColor: TIER_COLORS[m.tier || 'standard'] || 'text-blue-400',
      })),
    }))

    return NextResponse.json({
      providers: result,
      flat: allModels.map(m => ({
        name: m.name,
        alias: m.alias,
        provider: m.provider,
        tier: m.tier || 'standard',
        tierLabel: TIER_LABELS[m.tier || 'standard'] || '$$',
      })),
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/models error')
    return NextResponse.json({ error: 'Failed to fetch models' }, { status: 500 })
  }
}
