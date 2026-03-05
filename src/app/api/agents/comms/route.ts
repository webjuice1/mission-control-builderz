import { NextRequest, NextResponse } from "next/server"
import { getDatabase, Message, db_helpers } from "@/lib/db"
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import { eventBus } from '@/lib/event-bus'
import { logger } from '@/lib/logger'

/**
 * GET /api/agents/comms - Inter-agent communication stats and timeline
 * Query params: limit, offset, since, agent
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const db = getDatabase()
    const { searchParams } = new URL(request.url)
    const workspaceId = auth.user.workspace_id ?? 1

    const limit = parseInt(searchParams.get("limit") || "100")
    const offset = parseInt(searchParams.get("offset") || "0")
    const since = searchParams.get("since")
    const agent = searchParams.get("agent")

    // Filter out human/system messages - only agent-to-agent
    const humanNames = ["human", "system", "operator"]
    const humanPlaceholders = humanNames.map(() => "?").join(",")

    // 1. Get inter-agent messages
    let messagesQuery = `
      SELECT * FROM messages
      WHERE workspace_id = ?
        AND to_agent IS NOT NULL
        AND from_agent NOT IN (${humanPlaceholders})
        AND to_agent NOT IN (${humanPlaceholders})
    `
    const messagesParams: any[] = [workspaceId, ...humanNames, ...humanNames]

    if (since) {
      messagesQuery += " AND created_at > ?"
      messagesParams.push(parseInt(since))
    }
    if (agent) {
      messagesQuery += " AND (from_agent = ? OR to_agent = ?)"
      messagesParams.push(agent, agent)
    }

    // Deterministic chronological ordering prevents visual jumps in UI
    messagesQuery += " ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?"
    messagesParams.push(limit, offset)

    const messages = db.prepare(messagesQuery).all(...messagesParams) as Message[]

    // 2. Communication graph edges
    let graphQuery = `
      SELECT
        from_agent, to_agent,
        COUNT(*) as message_count,
        MAX(created_at) as last_message_at
      FROM messages
      WHERE workspace_id = ?
        AND to_agent IS NOT NULL
        AND from_agent NOT IN (${humanPlaceholders})
        AND to_agent NOT IN (${humanPlaceholders})
    `
    const graphParams: any[] = [workspaceId, ...humanNames, ...humanNames]
    if (since) {
      graphQuery += " AND created_at > ?"
      graphParams.push(parseInt(since))
    }
    graphQuery += " GROUP BY from_agent, to_agent ORDER BY message_count DESC"

    const edges = db.prepare(graphQuery).all(...graphParams)

    // 3. Per-agent sent/received stats
    const statsQuery = `
      SELECT agent, SUM(sent) as sent, SUM(received) as received FROM (
        SELECT from_agent as agent, COUNT(*) as sent, 0 as received
        FROM messages WHERE workspace_id = ? AND to_agent IS NOT NULL
          AND from_agent NOT IN (${humanPlaceholders})
          AND to_agent NOT IN (${humanPlaceholders})
        GROUP BY from_agent
        UNION ALL
        SELECT to_agent as agent, 0 as sent, COUNT(*) as received
        FROM messages WHERE workspace_id = ? AND to_agent IS NOT NULL
          AND from_agent NOT IN (${humanPlaceholders})
          AND to_agent NOT IN (${humanPlaceholders})
        GROUP BY to_agent
      ) GROUP BY agent ORDER BY (sent + received) DESC
    `
    const statsParams = [workspaceId, ...humanNames, ...humanNames, workspaceId, ...humanNames, ...humanNames]
    const agentStats = db.prepare(statsQuery).all(...statsParams)

    // 4. Total count
    let countQuery = `
      SELECT COUNT(*) as total FROM messages
      WHERE workspace_id = ?
        AND to_agent IS NOT NULL
        AND from_agent NOT IN (${humanPlaceholders})
        AND to_agent NOT IN (${humanPlaceholders})
    `
    const countParams: any[] = [workspaceId, ...humanNames, ...humanNames]
    if (since) {
      countQuery += " AND created_at > ?"
      countParams.push(parseInt(since))
    }
    if (agent) {
      countQuery += " AND (from_agent = ? OR to_agent = ?)"
      countParams.push(agent, agent)
    }
    const { total } = db.prepare(countQuery).get(...countParams) as { total: number }

    let seededCountQuery = `
      SELECT COUNT(*) as seeded FROM messages
      WHERE workspace_id = ?
        AND to_agent IS NOT NULL
        AND from_agent NOT IN (${humanPlaceholders})
        AND to_agent NOT IN (${humanPlaceholders})
        AND conversation_id LIKE ?
    `
    const seededParams: any[] = [workspaceId, ...humanNames, ...humanNames, "conv-multi-%"]
    if (since) {
      seededCountQuery += " AND created_at > ?"
      seededParams.push(parseInt(since))
    }
    if (agent) {
      seededCountQuery += " AND (from_agent = ? OR to_agent = ?)"
      seededParams.push(agent, agent)
    }
    const { seeded } = db.prepare(seededCountQuery).get(...seededParams) as { seeded: number }

    const seededCount = seeded || 0
    const liveCount = Math.max(0, total - seededCount)
    const source =
      total === 0 ? "empty" :
      liveCount === 0 ? "seeded" :
      seededCount === 0 ? "live" :
      "mixed"

    const parsed = messages.map((msg) => {
      let parsedMetadata: any = null
      if (msg.metadata) {
        try {
          parsedMetadata = JSON.parse(msg.metadata)
        } catch {
          // Keep endpoint resilient even if one legacy row has bad metadata
          parsedMetadata = null
        }
      }
      return {
        ...msg,
        metadata: parsedMetadata,
      }
    })

    return NextResponse.json({
      messages: parsed,
      total,
      graph: { edges, agentStats },
      source: { mode: source, seededCount, liveCount },
    })
  } catch (error) {
    logger.error({ err: error }, "GET /api/agents/comms error")
    return NextResponse.json({ error: "Failed to fetch agent communications" }, { status: 500 })
  }
}

/**
 * POST /api/agents/comms - Store an agent-to-agent message directly in DB
 * Body: { from, to, message, type?, metadata? }
 */
export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const db = getDatabase()
    const workspaceId = auth.user.workspace_id ?? 1
    const body = await request.json()

    const from = (body.from || '').trim()
    const to = (body.to || '').trim()
    const message = (body.message || body.content || '').trim()
    const messageType = body.type || body.message_type || 'text'
    const metadata = body.metadata || null

    if (!from || !to || !message) {
      return NextResponse.json(
        { error: '"from", "to", and "message" are required' },
        { status: 400 }
      )
    }

    const conversation_id = body.conversation_id || `a2a:${from}:${to}`

    const stmt = db.prepare(`
      INSERT INTO messages (conversation_id, from_agent, to_agent, content, message_type, metadata, workspace_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)

    const result = stmt.run(
      conversation_id,
      from,
      to,
      message,
      messageType,
      metadata ? JSON.stringify(metadata) : null,
      workspaceId
    )

    const messageId = result.lastInsertRowid as number
    const created = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId) as Message

    // Parse metadata for broadcast
    const parsedMessage = {
      ...created,
      metadata: created.metadata ? JSON.parse(created.metadata) : null,
    }

    // Broadcast to SSE clients so the UI updates in real-time
    eventBus.broadcast('chat.message', parsedMessage)

    // Create notification for recipient
    db_helpers.createNotification(
      to,
      'message',
      'Agent Message',
      `${from}: ${message.substring(0, 200)}${message.length > 200 ? '...' : ''}`,
      'agent',
      messageId,
      workspaceId
    )

    // Log activity
    db_helpers.logActivity(
      'agent_message',
      'message',
      messageId,
      from,
      `Sent message to ${to}`,
      { to, conversation_id },
      workspaceId
    )

    return NextResponse.json({
      success: true,
      message: parsedMessage,
    }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, "POST /api/agents/comms error")
    return NextResponse.json({ error: "Failed to store agent message" }, { status: 500 })
  }
}
