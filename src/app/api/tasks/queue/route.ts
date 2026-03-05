import { NextRequest, NextResponse } from 'next/server'
import { getDatabase, Task, db_helpers } from '@/lib/db'
import { requireRole } from '@/lib/auth'
import { logger } from '@/lib/logger'

/**
 * GET /api/tasks/queue - Agent polls for next available task
 * 
 * Query params:
 *   agent - Agent name (required) - returns next task assigned to this agent
 *   status - Filter by status (default: 'assigned' or 'inbox')
 *   limit - Max tasks to return (default: 1)
 *   claim - If 'true', automatically move task to 'in_progress'
 * 
 * Priority ordering: urgent > high > medium > low, then oldest first
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const db = getDatabase()
    const { searchParams } = new URL(request.url)
    const workspaceId = auth.user.workspace_id ?? 1

    const agent = searchParams.get('agent')
    if (!agent) {
      return NextResponse.json({ error: 'agent parameter is required' }, { status: 400 })
    }

    const limit = Math.min(parseInt(searchParams.get('limit') || '1'), 20)
    const claim = searchParams.get('claim') === 'true'
    const statusFilter = searchParams.get('status')

    // Priority ordering map
    const priorityOrder = `
      CASE priority
        WHEN 'urgent' THEN 1
        WHEN 'critical' THEN 1
        WHEN 'high' THEN 2
        WHEN 'medium' THEN 3
        WHEN 'low' THEN 4
        ELSE 5
      END
    `

    let query = `
      SELECT * FROM tasks
      WHERE workspace_id = ?
        AND assigned_to = ?
    `
    const params: any[] = [workspaceId, agent]

    if (statusFilter) {
      query += ' AND status = ?'
      params.push(statusFilter)
    } else {
      // Default: show tasks that are ready to work on
      query += " AND status IN ('assigned', 'inbox')"
    }

    query += ` ORDER BY ${priorityOrder} ASC, created_at ASC LIMIT ?`
    params.push(limit)

    const tasks = db.prepare(query).all(...params) as Task[]

    // If claim=true, move the first task to in_progress
    if (claim && tasks.length > 0) {
      const task = tasks[0]
      const now = Math.floor(Date.now() / 1000)
      db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND workspace_id = ?')
        .run('in_progress', now, task.id, workspaceId)
      task.status = 'in_progress' as any
      task.updated_at = now

      db_helpers.logActivity(
        'task_claimed',
        'task',
        task.id,
        agent,
        `Agent ${agent} claimed task: ${task.title}`,
        { previous_status: 'assigned' },
        workspaceId
      )
    }

    const parsed = tasks.map(task => ({
      ...task,
      tags: task.tags ? JSON.parse(task.tags) : [],
      metadata: task.metadata ? JSON.parse(task.metadata) : {},
    }))

    return NextResponse.json({
      tasks: parsed,
      count: parsed.length,
      agent,
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/tasks/queue error')
    return NextResponse.json({ error: 'Failed to fetch task queue' }, { status: 500 })
  }
}

/**
 * POST /api/tasks/queue - Agent completes a task and triggers handoff
 * 
 * Body:
 *   task_id - Task to complete
 *   agent - Agent name completing the task
 *   status - New status (default: 'review')
 *   output - Optional output/result text
 *   trigger_next - If true, check for dependent tasks and create/assign them
 */
export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const db = getDatabase()
    const workspaceId = auth.user.workspace_id ?? 1
    const body = await request.json()
    const { task_id, agent, status = 'review', output, trigger_next = true } = body

    if (!task_id || !agent) {
      return NextResponse.json({ error: 'task_id and agent are required' }, { status: 400 })
    }

    const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND workspace_id = ?')
      .get(task_id, workspaceId) as Task | undefined
    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 })
    }

    const now = Math.floor(Date.now() / 1000)

    // Update task status
    db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND workspace_id = ?')
      .run(status, now, task_id, workspaceId)

    db_helpers.logActivity(
      'task_completed_by_agent',
      'task',
      task_id,
      agent,
      `Agent ${agent} completed task: ${task.title}`,
      { output: output?.substring(0, 500), new_status: status },
      workspaceId
    )

    // Store output as a comment if provided
    if (output) {
      db.prepare(`
        INSERT INTO comments (task_id, author, content, created_at, workspace_id)
        VALUES (?, ?, ?, ?, ?)
      `).run(task_id, agent, `📋 Task output:\n${output}`, now, workspaceId)
    }

    // Check for dependent tasks (handoffs)
    const triggered: any[] = []
    if (trigger_next) {
      const deps = db.prepare(`
        SELECT * FROM task_dependencies
        WHERE parent_task_id = ? AND workspace_id = ?
        ORDER BY execution_order ASC
      `).all(task_id, workspaceId) as any[]

      for (const dep of deps) {
        if (dep.child_task_id) {
          // Existing task dependency - unblock it
          const childTask = db.prepare('SELECT * FROM tasks WHERE id = ? AND workspace_id = ?')
            .get(dep.child_task_id, workspaceId) as Task | undefined
          if (childTask && (childTask.status === 'blocked' || childTask.status === 'inbox')) {
            db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND workspace_id = ?')
              .run('assigned', now, dep.child_task_id, workspaceId)

            db_helpers.logActivity(
              'task_unblocked',
              'task',
              dep.child_task_id,
              'system',
              `Task unblocked by completion of "${task.title}"`,
              { parent_task_id: task_id, triggered_by: agent },
              workspaceId
            )

            if (childTask.assigned_to) {
              db_helpers.createNotification(
                childTask.assigned_to,
                'handoff',
                'Task Handoff',
                `"${task.title}" is done → your task "${childTask.title}" is now ready`,
                'task',
                dep.child_task_id,
                workspaceId
              )

              // Send inter-agent message about the handoff
              db.prepare(`
                INSERT INTO messages (conversation_id, from_agent, to_agent, content, message_type, metadata, workspace_id)
                VALUES (?, ?, ?, ?, 'handoff', ?, ?)
              `).run(
                `handoff:${task_id}:${dep.child_task_id}`,
                agent,
                childTask.assigned_to,
                `✅ I've completed "${task.title}". Your task "${childTask.title}" is now ready to pick up.${output ? `\n\nContext: ${output.substring(0, 300)}` : ''}`,
                JSON.stringify({ parent_task_id: task_id, child_task_id: dep.child_task_id }),
                workspaceId
              )
            }

            triggered.push({
              task_id: dep.child_task_id,
              title: childTask.title,
              assigned_to: childTask.assigned_to,
              action: 'unblocked',
            })
          }
        } else if (dep.template_config) {
          // Auto-create task from template config
          const config = JSON.parse(dep.template_config)
          const newTitle = config.title_template
            ? config.title_template.replace('{parent_title}', task.title)
            : `Follow-up: ${task.title}`

          const insertResult = db.prepare(`
            INSERT INTO tasks (title, description, status, priority, assigned_to, created_by, created_at, updated_at, tags, metadata, workspace_id)
            VALUES (?, ?, 'assigned', ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            newTitle,
            config.description || `Auto-created from completion of "${task.title}"`,
            config.priority || task.priority,
            config.assigned_to,
            'system',
            now, now,
            JSON.stringify(config.tags || []),
            JSON.stringify({ parent_task_id: task_id, auto_created: true, ...(config.metadata || {}) }),
            workspaceId
          )

          const newTaskId = Number(insertResult.lastInsertRowid)

          if (config.assigned_to) {
            db_helpers.createNotification(
              config.assigned_to,
              'handoff',
              'New Task from Handoff',
              `"${task.title}" is done → new task "${newTitle}" assigned to you`,
              'task',
              newTaskId,
              workspaceId
            )

            db.prepare(`
              INSERT INTO messages (conversation_id, from_agent, to_agent, content, message_type, metadata, workspace_id)
              VALUES (?, ?, ?, ?, 'handoff', ?, ?)
            `).run(
              `handoff:${task_id}:${newTaskId}`,
              agent,
              config.assigned_to,
              `✅ I've completed "${task.title}". A new task "${newTitle}" has been created for you.${output ? `\n\nContext: ${output.substring(0, 300)}` : ''}`,
              JSON.stringify({ parent_task_id: task_id, new_task_id: newTaskId }),
              workspaceId
            )
          }

          triggered.push({
            task_id: newTaskId,
            title: newTitle,
            assigned_to: config.assigned_to,
            action: 'created',
          })
        }
      }
    }

    return NextResponse.json({
      success: true,
      task_id,
      new_status: status,
      triggered_tasks: triggered,
    })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/tasks/queue error')
    return NextResponse.json({ error: 'Failed to complete task' }, { status: 500 })
  }
}
