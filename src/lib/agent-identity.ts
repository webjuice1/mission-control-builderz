/**
 * Agent identity map — maps openclaw agent IDs to display names, emojis, and colors.
 * Single source of truth for agent presentation across the MC UI.
 */

export interface AgentIdentity {
  label: string
  emoji: string
  color: string
}

const AGENT_MAP: Record<string, AgentIdentity> = {
  main:     { label: 'Jimmy',  emoji: '⚡', color: '#a78bfa' },
  pm:       { label: 'Max',    emoji: '👨‍💻', color: '#60a5fa' },
  seo:      { label: 'Leo',    emoji: '🔍', color: '#22d3ee' },
  content:  { label: 'Luna',   emoji: '✍️', color: '#818cf8' },
  social:   { label: 'Sage',   emoji: '🌿', color: '#4ade80' },
  webdev:   { label: 'Nova',   emoji: '⭐', color: '#fbbf24' },
  ads:      { label: 'Ace',    emoji: '🎯', color: '#fb923c' },
  research: { label: 'Scout',  emoji: '🔭', color: '#34d399' },
  spark:    { label: 'Spark',  emoji: '✨', color: '#f472b6' },
}

/**
 * Get identity for an agent by its openclaw ID.
 * Falls back to a generated identity for unknown agents.
 */
export function getAgentIdentity(agentId: string): AgentIdentity {
  const key = agentId.toLowerCase().replace(/^agent[_:]/, '')
  return AGENT_MAP[key] || {
    label: agentId.charAt(0).toUpperCase() + agentId.slice(1),
    emoji: agentId.charAt(0).toUpperCase(),
    color: '#9ca3af',
  }
}

/**
 * Get display name with emoji prefix: "⚡ Jimmy"
 */
export function getAgentDisplayName(agentId: string): string {
  const id = getAgentIdentity(agentId)
  return `${id.emoji} ${id.label}`
}

/**
 * Get all known agent IDs.
 */
export function getKnownAgentIds(): string[] {
  return Object.keys(AGENT_MAP)
}
