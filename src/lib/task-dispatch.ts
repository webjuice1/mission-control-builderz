import { getDatabase, db_helpers } from './db'
import { runCommand } from './command'
import { eventBus } from './event-bus'
import { logger } from './logger'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Build a sanitized env for openclaw agent calls (same fix as wake route) */
function buildAgentEnv(): NodeJS.ProcessEnv {
  const childEnv = { ...process.env }
  delete childEnv.OPENCLAW_HOME  // TOXIC: breaks agent ID resolution

  // Read gateway token from openclaw.json
  try {
    const home = process.env.HOME || '/Users/clowdbot'
    const configPath = process.env.OPENCLAW_CONFIG_PATH || join(home, '.openclaw', 'openclaw.json')
    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    const token = config?.gateway?.auth?.token
    if (token) childEnv.OPENCLAW_GATEWAY_TOKEN = token
  } catch {}

  childEnv.HOME = process.env.HOME || '/Users/clowdbot'
  return childEnv
}

/** Run openclaw agent --agent <sessionKey> --message <msg> --json, tolerating null exit codes */
async function runAgentCommand(sessionKey: string, message: string, timeoutMs = 120_000): Promise<{ stdout: string; stderr: string }> {
  const bin = process.env.OPENCLAW_BIN || '/opt/homebrew/bin/openclaw'
  const args = ['agent', '--agent', sessionKey, '--message', message, '--json']
  const env = buildAgentEnv()

  try {
    const result = await runCommand(bin, args, { timeoutMs, cwd: '/tmp', env })
    return result
  } catch (err: any) {
    // openclaw agent --json exits with null code even on success
    const stdout = err.stdout || ''
    try {
      const parsed = JSON.parse(stdout)
      if (parsed?.status === 'ok') return { stdout, stderr: err.stderr || '' }
    } catch {}
    throw err
  }
}

interface DispatchableTask {
  id: number
  title: string
  description: string | null
  status: string
  priority: string
  assigned_to: string
  workspace_id: number
  agent_name: string
  agent_id: number
  ticket_prefix: string | null
  project_ticket_no: number | null
  project_id: number | null
  tags?: string[]
}

function buildTaskPrompt(task: DispatchableTask, rejectionFeedback?: string | null): string {
  const ticket = task.ticket_prefix && task.project_ticket_no
    ? `${task.ticket_prefix}-${String(task.project_ticket_no).padStart(3, '0')}`
    : `TASK-${task.id}`

  const lines = [
    'You have been assigned a task in Mission Control.',
    '',
    `**[${ticket}] ${task.title}**`,
    `Priority: ${task.priority}`,
  ]

  if (task.tags && task.tags.length > 0) {
    lines.push(`Tags: ${task.tags.join(', ')}`)
  }

  if (task.description) {
    lines.push('', task.description)
  }

  if (rejectionFeedback) {
    lines.push('', '## Previous Review Feedback', rejectionFeedback, '', 'Please address this feedback in your response.')
  }

  lines.push('', 'Complete this task and provide your response. Be concise and actionable.')
  return lines.join('\n')
}

/** Extract first valid JSON object from raw stdout (handles surrounding text/warnings). */
function parseGatewayJson(raw: string): any | null {
  const trimmed = String(raw || '').trim()
  if (!trimmed) return null
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end < start) return null
  try {
    return JSON.parse(trimmed.slice(start, end + 1))
  } catch {
    return null
  }
}

interface AgentResponseParsed {
  text: string | null
  sessionId: string | null
}

function parseAgentResponse(stdout: string): AgentResponseParsed {
  try {
    const parsed = JSON.parse(stdout)
    const sessionId: string | null =
      parsed?.result?.meta?.agentMeta?.sessionId
      || (typeof parsed?.sessionId === 'string' ? parsed.sessionId : null)
      || (typeof parsed?.session_id === 'string' ? parsed.session_id : null)

    // openclaw agent --json returns { result: { payloads: [{ text: "..." }] } }
    if (parsed?.result?.payloads?.[0]?.text) {
      return { text: parsed.result.payloads[0].text, sessionId }
    }
    // Flat payloads (legacy)
    if (parsed?.payloads?.[0]?.text) {
      return { text: parsed.payloads[0].text, sessionId }
    }
    // Fallback: if there's a result with text content
    if (parsed?.result && typeof parsed.result === 'string') {
      return { text: parsed.result, sessionId }
    }
    if (parsed?.output) return { text: String(parsed.output), sessionId }
    // Last resort: stringify the whole response
    return { text: JSON.stringify(parsed, null, 2), sessionId }
  } catch {
    // Not valid JSON — return raw stdout if non-empty
    return { text: stdout.trim() || null, sessionId: null }
  }
}

interface ReviewableTask {
  id: number
  title: string
  description: string | null
  resolution: string | null
  assigned_to: string | null
  workspace_id: number
  ticket_prefix: string | null
  project_ticket_no: number | null
}

function buildReviewPrompt(task: ReviewableTask): string {
  const ticket = task.ticket_prefix && task.project_ticket_no
    ? `${task.ticket_prefix}-${String(task.project_ticket_no).padStart(3, '0')}`
    : `TASK-${task.id}`

  const lines = [
    'You are Aegis, the quality reviewer for Mission Control.',
    'Review the following completed task and its resolution.',
    '',
    `**[${ticket}] ${task.title}**`,
  ]

  if (task.description) {
    lines.push('', '## Task Description', task.description)
  }

  if (task.resolution) {
    lines.push('', '## Agent Resolution', task.resolution.substring(0, 6000))
  }

  lines.push(
    '',
    '## Instructions',
    'Evaluate whether the agent\'s response adequately addresses the task.',
    'Respond with EXACTLY one of these two formats:',
    '',
    'If the work is acceptable:',
    'VERDICT: APPROVED',
    'NOTES: <brief summary of why it passes>',
    '',
    'If the work needs improvement:',
    'VERDICT: REJECTED',
    'NOTES: <specific issues that need to be fixed>',
  )

  return lines.join('\n')
}

function parseReviewVerdict(text: string): { status: 'approved' | 'rejected'; notes: string } {
  const upper = text.toUpperCase()
  const status = upper.includes('VERDICT: APPROVED') ? 'approved' as const : 'rejected' as const
  const notesMatch = text.match(/NOTES:\s*(.+)/i)
  const notes = notesMatch?.[1]?.trim().substring(0, 2000) || (status === 'approved' ? 'Quality check passed' : 'Quality check failed')
  return { status, notes }
}

/**
 * Run Aegis quality reviews on tasks in 'review' status.
 * Uses an agent to evaluate the task resolution, then approves or rejects.
 */
export async function runAegisReviews(): Promise<{ ok: boolean; message: string }> {
  const db = getDatabase()

  const tasks = db.prepare(`
    SELECT t.id, t.title, t.description, t.resolution, t.assigned_to, t.workspace_id,
           p.ticket_prefix, t.project_ticket_no
    FROM tasks t
    LEFT JOIN projects p ON p.id = t.project_id AND p.workspace_id = t.workspace_id
    WHERE t.status = 'review'
    ORDER BY t.updated_at ASC
    LIMIT 3
  `).all() as ReviewableTask[]

  if (tasks.length === 0) {
    return { ok: true, message: 'No tasks awaiting review' }
  }

  const results: Array<{ id: number; verdict: string; error?: string }> = []

  for (const task of tasks) {
    // Move to quality_review to prevent re-processing
    db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?')
      .run('quality_review', Math.floor(Date.now() / 1000), task.id)

    eventBus.broadcast('task.status_changed', {
      id: task.id,
      status: 'quality_review',
      previous_status: 'review',
    })

    try {
      const prompt = buildReviewPrompt(task)
      // Use the assigned agent's session_key or fall back to main
      const reviewAgentName = task.assigned_to || 'Jimmy'
      const reviewRow = db.prepare('SELECT session_key FROM agents WHERE name = ?')
        .get(reviewAgentName) as { session_key: string } | undefined
      const reviewSessionKey = reviewRow?.session_key || 'main'

      // Dispatch review via openclaw agent CLI
      const reviewResult = await runAgentCommand(reviewSessionKey, prompt, 120_000)
      const agentResponse = parseAgentResponse(reviewResult.stdout)
      if (!agentResponse.text) {
        throw new Error('Aegis review returned empty response')
      }

      const verdict = parseReviewVerdict(agentResponse.text)

      // Insert quality review record
      db.prepare(`
        INSERT INTO quality_reviews (task_id, reviewer, status, notes, workspace_id)
        VALUES (?, 'aegis', ?, ?, ?)
      `).run(task.id, verdict.status, verdict.notes, task.workspace_id)

      if (verdict.status === 'approved') {
        db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?')
          .run('done', Math.floor(Date.now() / 1000), task.id)

        eventBus.broadcast('task.status_changed', {
          id: task.id,
          status: 'done',
          previous_status: 'quality_review',
        })
      } else {
        // Rejected: push back to in_progress with feedback
        db.prepare('UPDATE tasks SET status = ?, error_message = ?, updated_at = ? WHERE id = ?')
          .run('in_progress', `Aegis rejected: ${verdict.notes}`, Math.floor(Date.now() / 1000), task.id)

        eventBus.broadcast('task.status_changed', {
          id: task.id,
          status: 'in_progress',
          previous_status: 'quality_review',
        })

        // Add rejection as a comment so the agent sees it on next dispatch
        db.prepare(`
          INSERT INTO comments (task_id, author, content, created_at, workspace_id)
          VALUES (?, 'aegis', ?, ?, ?)
        `).run(task.id, `Quality Review Rejected:\n${verdict.notes}`, Math.floor(Date.now() / 1000), task.workspace_id)
      }

      db_helpers.logActivity(
        'aegis_review',
        'task',
        task.id,
        'aegis',
        `Aegis ${verdict.status} task "${task.title}": ${verdict.notes.substring(0, 200)}`,
        { verdict: verdict.status, notes: verdict.notes },
        task.workspace_id
      )

      results.push({ id: task.id, verdict: verdict.status })
      logger.info({ taskId: task.id, verdict: verdict.status }, 'Aegis review completed')
    } catch (err: any) {
      const errorMsg = err.message || 'Unknown error'
      logger.error({ taskId: task.id, err }, 'Aegis review failed')

      // Revert to review so it can be retried
      db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?')
        .run('review', Math.floor(Date.now() / 1000), task.id)

      eventBus.broadcast('task.status_changed', {
        id: task.id,
        status: 'review',
        previous_status: 'quality_review',
      })

      results.push({ id: task.id, verdict: 'error', error: errorMsg.substring(0, 100) })
    }
  }

  const approved = results.filter(r => r.verdict === 'approved').length
  const rejected = results.filter(r => r.verdict === 'rejected').length
  const errors = results.filter(r => r.verdict === 'error').length

  return {
    ok: errors === 0,
    message: `Reviewed ${tasks.length}: ${approved} approved, ${rejected} rejected${errors ? `, ${errors} error(s)` : ''}`,
  }
}

export async function dispatchAssignedTasks(): Promise<{ ok: boolean; message: string }> {
  const db = getDatabase()

  const tasks = db.prepare(`
    SELECT t.*, a.name as agent_name, a.id as agent_id,
           p.ticket_prefix, t.project_ticket_no
    FROM tasks t
    JOIN agents a ON a.name = t.assigned_to AND a.workspace_id = t.workspace_id
    LEFT JOIN projects p ON p.id = t.project_id AND p.workspace_id = t.workspace_id
    WHERE t.status = 'assigned'
      AND t.assigned_to IS NOT NULL
    ORDER BY
      CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END ASC,
      t.created_at ASC
    LIMIT 3
  `).all() as (DispatchableTask & { tags?: string })[]

  if (tasks.length === 0) {
    return { ok: true, message: 'No assigned tasks to dispatch' }
  }

  // Parse JSON tags column
  for (const task of tasks) {
    if (typeof task.tags === 'string') {
      try { task.tags = JSON.parse(task.tags as string) } catch { task.tags = undefined }
    }
  }

  const results: Array<{ id: number; success: boolean; error?: string }> = []
  const now = Math.floor(Date.now() / 1000)

  for (const task of tasks) {
    // Mark as in_progress immediately to prevent re-dispatch
    db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?')
      .run('in_progress', now, task.id)

    eventBus.broadcast('task.status_changed', {
      id: task.id,
      status: 'in_progress',
      previous_status: 'assigned',
    })

    db_helpers.logActivity(
      'task_dispatched',
      'task',
      task.id,
      'scheduler',
      `Dispatching task "${task.title}" to agent ${task.agent_name}`,
      { agent: task.agent_name, priority: task.priority },
      task.workspace_id
    )

    try {
      // Check for previous Aegis rejection feedback
      const rejectionRow = db.prepare(`
        SELECT content FROM comments
        WHERE task_id = ? AND author = 'aegis' AND content LIKE 'Quality Review Rejected:%'
        ORDER BY created_at DESC LIMIT 1
      `).get(task.id) as { content: string } | undefined
      const rejectionFeedback = rejectionRow?.content?.replace(/^Quality Review Rejected:\n?/, '') || null

      const prompt = buildTaskPrompt(task, rejectionFeedback)

      // Look up the agent's session_key
      const agentRow = db.prepare('SELECT session_key FROM agents WHERE name = ? AND workspace_id = ?')
        .get(task.agent_name, task.workspace_id) as { session_key: string } | undefined
      const sessionKey = agentRow?.session_key || task.agent_name.toLowerCase()

      // Dispatch via openclaw agent CLI (direct, no broken gateway call)
      const result = await runAgentCommand(sessionKey, prompt, 120_000)
      const agentResponse = parseAgentResponse(result.stdout)

      if (!agentResponse.text) {
        throw new Error('Agent returned empty response')
      }

      const truncated = agentResponse.text.length > 10_000
        ? agentResponse.text.substring(0, 10_000) + '\n\n[Response truncated at 10,000 characters]'
        : agentResponse.text

      // Merge dispatch_session_id into existing metadata
      const existingMeta = (() => {
        try {
          const row = db.prepare('SELECT metadata FROM tasks WHERE id = ?').get(task.id) as { metadata: string } | undefined
          return row?.metadata ? JSON.parse(row.metadata) : {}
        } catch { return {} }
      })()
      if (agentResponse.sessionId) {
        existingMeta.dispatch_session_id = agentResponse.sessionId
      }

      // Update task: status → review, set outcome
      db.prepare(`
        UPDATE tasks SET status = ?, outcome = ?, resolution = ?, metadata = ?, updated_at = ? WHERE id = ?
      `).run('review', 'success', truncated, JSON.stringify(existingMeta), Math.floor(Date.now() / 1000), task.id)

      // Add a comment from the agent with the full response
      db.prepare(`
        INSERT INTO comments (task_id, author, content, created_at, workspace_id)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        task.id,
        task.agent_name,
        truncated,
        Math.floor(Date.now() / 1000),
        task.workspace_id
      )

      eventBus.broadcast('task.status_changed', {
        id: task.id,
        status: 'review',
        previous_status: 'in_progress',
      })

      eventBus.broadcast('task.updated', {
        id: task.id,
        status: 'review',
        outcome: 'success',
        assigned_to: task.assigned_to,
        dispatch_session_id: agentResponse.sessionId,
      })

      db_helpers.logActivity(
        'task_agent_completed',
        'task',
        task.id,
        task.agent_name,
        `Agent completed task "${task.title}" — awaiting review`,
        { response_length: agentResponse.text.length, dispatch_session_id: agentResponse.sessionId },
        task.workspace_id
      )

      results.push({ id: task.id, success: true })
      logger.info({ taskId: task.id, agent: task.agent_name }, 'Task dispatched and completed')
    } catch (err: any) {
      const errorMsg = err.message || 'Unknown error'
      logger.error({ taskId: task.id, agent: task.agent_name, err }, 'Task dispatch failed')

      // Revert to assigned so it can be retried on the next tick
      db.prepare('UPDATE tasks SET status = ?, error_message = ?, updated_at = ? WHERE id = ?')
        .run('assigned', errorMsg.substring(0, 5000), Math.floor(Date.now() / 1000), task.id)

      eventBus.broadcast('task.status_changed', {
        id: task.id,
        status: 'assigned',
        previous_status: 'in_progress',
      })

      db_helpers.logActivity(
        'task_dispatch_failed',
        'task',
        task.id,
        'scheduler',
        `Task dispatch failed for "${task.title}": ${errorMsg.substring(0, 200)}`,
        { error: errorMsg.substring(0, 1000) },
        task.workspace_id
      )

      results.push({ id: task.id, success: false, error: errorMsg.substring(0, 100) })
    }
  }

  const succeeded = results.filter(r => r.success).length
  const failed = results.filter(r => !r.success)
  const failSummary = failed.length > 0
    ? ` (${failed.length} failed: ${failed.map(f => f.error).join('; ')})`
    : ''

  return {
    ok: failed.length === 0,
    message: `Dispatched ${succeeded}/${tasks.length} tasks${failSummary}`,
  }
}
