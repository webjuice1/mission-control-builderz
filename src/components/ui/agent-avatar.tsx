'use client'

import { getAgentIdentity } from '@/lib/agent-identity'

interface AgentAvatarProps {
  name: string
  size?: 'xs' | 'sm' | 'md'
  className?: string
}

const sizeClasses: Record<NonNullable<AgentAvatarProps['size']>, string> = {
  xs: 'w-5 h-5 text-[10px]',
  sm: 'w-6 h-6 text-[10px]',
  md: 'w-8 h-8 text-xs',
}

const emojiSizeClasses: Record<NonNullable<AgentAvatarProps['size']>, string> = {
  xs: 'text-[11px]',
  sm: 'text-[13px]',
  md: 'text-base',
}

export function AgentAvatar({ name, size = 'sm', className = '' }: AgentAvatarProps) {
  const identity = getAgentIdentity(name)
  const displayName = `${identity.emoji} ${identity.label}`

  return (
    <div
      className={`rounded-full flex items-center justify-center font-semibold shrink-0 ${sizeClasses[size]} ${className}`}
      style={{ backgroundColor: identity.color, color: 'hsl(0 0% 98%)' }}
      title={displayName}
      aria-label={displayName}
    >
      <span className={emojiSizeClasses[size]}>{identity.emoji}</span>
    </div>
  )
}
