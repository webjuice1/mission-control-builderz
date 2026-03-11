import { NextRequest, NextResponse } from 'next/server'
import { getDatabase, db_helpers } from '@/lib/db'
import { runCommand } from '@/lib/command'
import { requireRole } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { readFileSync } from 'fs'
import { join } from 'path'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const resolvedParams = await params
    const agentId = resolvedParams.id
    const workspaceId = auth.user.workspace_id ?? 1;
    const body = await request.json().catch(() => ({}))
    const customMessage =
      typeof body?.message === 'string' ? body.message.trim() : ''

    const db = getDatabase()
    const agent: any = isNaN(Number(agentId))
      ? db.prepare('SELECT * FROM agents WHERE name = ? AND workspace_id = ?').get(agentId, workspaceId)
      : db.prepare('SELECT * FROM agents WHERE id = ? AND workspace_id = ?').get(Number(agentId), workspaceId)

    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
    }

    if (!agent.session_key) {
      return NextResponse.json(
        { error: 'Agent has no session key configured' },
        { status: 400 }
      )
    }

    const message =
      customMessage ||
      `Wake up check-in for ${agent.name}. Please review assigned tasks and notifications.`

    // Read gateway token from openclaw config
    let gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN || ''
    try {
      const home = process.env.HOME || '/Users/clowdbot'
      const raw = readFileSync(join(home, '.openclaw', 'openclaw.json'), 'utf-8')
      gatewayToken = JSON.parse(raw)?.gateway?.auth?.token || gatewayToken
    } catch {}

    // Build sanitized env: strip OPENCLAW_HOME (breaks agent lookup)
    const childEnv = { ...process.env }
    delete childEnv.OPENCLAW_HOME
    childEnv.OPENCLAW_GATEWAY_TOKEN = gatewayToken
    childEnv.HOME = process.env.HOME || '/Users/clowdbot'

    const args = [
      'agent',
      '--agent', agent.session_key,
      '--message', message,
      '--json'
    ]

    let stdout = ''
    let stderr = ''
    try {
      const result = await runCommand(
        process.env.OPENCLAW_BIN || '/opt/homebrew/bin/openclaw',
        args,
        { timeoutMs: 30000, cwd: '/tmp', env: childEnv }
      )
      stdout = result.stdout
      stderr = result.stderr
    } catch (err: any) {
      // openclaw agent --json may exit with null code even on success.
      // If stdout contains valid JSON with status:"ok", treat it as success.
      stdout = err.stdout || ''
      stderr = err.stderr || ''
      try {
        const parsed = JSON.parse(stdout)
        if (parsed?.status !== 'ok') throw err
      } catch (parseErr) {
        if (parseErr === err) throw err
        throw err
      }
    }

    // Parse response
    let response: any = {}
    try { response = JSON.parse(stdout) } catch {}

    db_helpers.updateAgentStatus(agent.name, 'idle', 'Manual wake', workspaceId)

    return NextResponse.json({
      success: true,
      agent: agent.name,
      session_key: agent.session_key,
      response: response?.result?.payloads?.[0]?.text || stdout.substring(0, 500)
    })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/agents/[id]/wake error')
    return NextResponse.json({ error: 'Failed to wake agent' }, { status: 500 })
  }
}
