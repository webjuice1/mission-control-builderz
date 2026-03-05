export interface ModelConfig {
  alias: string
  name: string
  provider: string
  description: string
  costPer1k: number
  tier?: 'budget' | 'standard' | 'premium'
}

/**
 * Static catalog of known models with metadata.
 * The /api/models endpoint enriches this with live data from OpenClaw.
 */
export const MODEL_CATALOG: ModelConfig[] = [
  // Anthropic
  { alias: 'opus46', name: 'anthropic/claude-opus-4-6', provider: 'anthropic', description: 'Latest Opus — top tier', costPer1k: 15.0, tier: 'premium' },
  { alias: 'opus', name: 'anthropic/claude-opus-4-5', provider: 'anthropic', description: 'Opus 4.5 — premium quality', costPer1k: 15.0, tier: 'premium' },
  { alias: 'sonnet', name: 'anthropic/claude-sonnet-4-6', provider: 'anthropic', description: 'Sonnet 4.6 — balanced workhorse', costPer1k: 3.0, tier: 'standard' },
  { alias: 'haiku', name: 'anthropic/claude-haiku-4-5', provider: 'anthropic', description: 'Haiku — ultra-fast & cheap', costPer1k: 0.25, tier: 'budget' },

  // OpenAI / Codex
  { alias: 'gpt53', name: 'openai-codex/gpt-5.3-codex', provider: 'openai-codex', description: 'GPT-5.3 Codex — latest coding', costPer1k: 10.0, tier: 'premium' },
  { alias: 'gpt', name: 'openai-codex/gpt-5.2', provider: 'openai-codex', description: 'GPT-5.2 — standard', costPer1k: 5.0, tier: 'standard' },
  { alias: 'gpt5', name: 'openai-codex/gpt-5', provider: 'openai-codex', description: 'GPT-5 — base', costPer1k: 5.0, tier: 'standard' },

  // xAI
  { alias: 'grok', name: 'xai/grok-3', provider: 'xai', description: 'Grok 3 — xAI reasoning', costPer1k: 3.0, tier: 'standard' },

  // OpenRouter
  { alias: 'kimi', name: 'openrouter/moonshotai/kimi-k2.5', provider: 'openrouter', description: 'Kimi K2.5 — alternative provider', costPer1k: 1.0, tier: 'standard' },

  // MiniMax
  { alias: 'minimax', name: 'minimax/MiniMax-M2.5', provider: 'minimax', description: 'MiniMax M2.5 — cost-effective coding', costPer1k: 0.3, tier: 'budget' },

  // Ollama (local)
  { alias: 'kimi-local', name: 'ollama/kimi-k2.5:cloud', provider: 'ollama', description: 'Kimi K2.5 Cloud (local)', costPer1k: 0.0, tier: 'budget' },

]

export const PROVIDER_LABELS: Record<string, string> = {
  'anthropic': '🟣 Anthropic',
  'openai-codex': '🟢 OpenAI',
  'xai': '⚡ xAI',
  'openrouter': '🌐 OpenRouter',
  'minimax': '🔷 MiniMax',
  'ollama': '🏠 Ollama (Local)',
}

export const TIER_LABELS: Record<string, string> = {
  premium: '$$$',
  standard: '$$',
  budget: '$',
}

export const TIER_COLORS: Record<string, string> = {
  premium: 'text-purple-400',
  standard: 'text-blue-400',
  budget: 'text-green-400',
}

export function getModelByAlias(alias: string): ModelConfig | undefined {
  return MODEL_CATALOG.find(m => m.alias === alias)
}

export function getModelByName(name: string): ModelConfig | undefined {
  return MODEL_CATALOG.find(m => m.name === name)
}

export function getAllModels(): ModelConfig[] {
  return [...MODEL_CATALOG]
}

/** Group models by provider */
export function getModelsByProvider(): Record<string, ModelConfig[]> {
  const grouped: Record<string, ModelConfig[]> = {}
  for (const model of MODEL_CATALOG) {
    if (!grouped[model.provider]) grouped[model.provider] = []
    grouped[model.provider].push(model)
  }
  return grouped
}
