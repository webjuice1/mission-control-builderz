import { NextRequest, NextResponse } from 'next/server'
import { getDatabase, Task, db_helpers } from '@/lib/db'
import { requireRole } from '@/lib/auth'
import { logger } from '@/lib/logger'

/**
 * POST /api/tasks/handoff - Create a full task chain with handoffs
 * 
 * Creates multiple tasks in sequence with dependencies between them.
 * When task N completes → task N+1 is unblocked and agent notified.
 * 
 * Body:
 * {
 *   name: "SEO → Content → Social Pipeline",
 *   tasks: [
 *     { title: "SEO Audit for client X", assigned_to: "leo", priority: "high", description: "..." },
 *     { title: "Write content based on SEO audit", assigned_to: "luna", priority: "high" },
 *     { title: "Create social posts from content", assigned_to: "sage", priority: "medium" }
 *   ]
 * }
 * 
 * First task gets status 'assigned', rest get 'blocked'.
 * Dependencies are auto-created between consecutive tasks.
 */
export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const db = getDatabase()
    const workspaceId = auth.user.workspace_id ?? 1
    const body = await request.json()
    const { name, tasks: taskDefs } = body

    if (!taskDefs || !Array.isArray(taskDefs) || taskDefs.length < 2) {
      return NextResponse.json({ error: 'At least 2 tasks are required for a handoff chain' }, { status: 400 })
    }

    const now = Math.floor(Date.now() / 1000)
    const createdTasks: any[] = []

    // Create all tasks in a transaction
    db.transaction(() => {
      for (let i = 0; i < taskDefs.length; i++) {
        const def = taskDefs[i]
        const isFirst = i === 0
        const status = isFirst ? 'assigned' : 'blocked'

        const result = db.prepare(`
          INSERT INTO tasks (title, description, status, priority, assigned_to, created_by, created_at, updated_at, tags, metadata, workspace_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          def.title,
          def.description || null,
          status,
          def.priority || 'medium',
          def.assigned_to || null,
          auth.user?.username || 'system',
          now, now,
          JSON.stringify(def.tags || []),
          JSON.stringify({
            ...(def.metadata || {}),
            handoff_chain: name || 'Unnamed Chain',
            chain_position: i,
            chain_total: taskDefs.length,
          }),
          workspaceId
        )

        createdTasks.push({
          id: Number(result.lastInsertRowid),
          title: def.title,
          assigned_to: def.assigned_to,
          status,
          position: i,
        })

        // Notify assigned agent for first task
        if (isFirst && def.assigned_to) {
          db_helpers.createNotification(
            def.assigned_to,
            'assignment',
            'New Task Chain',
            `You're starting the "${name || 'task chain'}": ${def.title}`,
            'task',
            Number(result.lastInsertRowid),
            workspaceId
          )
        }
      }

      // Create dependencies between consecutive tasks
      for (let i = 0; i < createdTasks.length - 1; i++) {
        db.prepare(`
          INSERT INTO task_dependencies (parent_task_id, child_task_id, execution_order, workspace_id)
          VALUES (?, ?, ?, ?)
        `).run(createdTasks[i].id, createdTasks[i + 1].id, i, workspaceId)
      }

      // Log the chain creation
      db_helpers.logActivity(
        'handoff_chain_created',
        'task',
        createdTasks[0].id,
        auth.user?.username || 'system',
        `Created handoff chain "${name || 'Unnamed'}": ${createdTasks.map(t => `${t.assigned_to || '?'}→`).join('').slice(0, -1)}`,
        {
          chain_name: name,
          task_ids: createdTasks.map(t => t.id),
          agents: createdTasks.map(t => t.assigned_to),
        },
        workspaceId
      )

      // Send agent-to-agent awareness message
      if (createdTasks.length >= 2) {
        const agentNames = createdTasks.map(t => t.assigned_to).filter(Boolean)
        const chainDesc = createdTasks.map(t => `${t.assigned_to || '?'}: "${t.title}"`).join(' → ')
        
        for (let i = 0; i < agentNames.length; i++) {
          db.prepare(`
            INSERT INTO messages (conversation_id, from_agent, to_agent, content, message_type, metadata, workspace_id)
            VALUES (?, ?, ?, ?, 'handoff', ?, ?)
          `).run(
            `chain:${createdTasks[0].id}`,
            'system',
            agentNames[i],
            `📋 New handoff chain "${name || 'Task Chain'}":\n${chainDesc}\n\n${i === 0 ? "You're up first!" : `You're #${i + 1} in the chain. You'll be notified when it's your turn.`}`,
            JSON.stringify({ chain_task_ids: createdTasks.map(t => t.id) }),
            workspaceId
          )
        }
      }
    })()

    return NextResponse.json({
      success: true,
      chain_name: name,
      tasks: createdTasks,
      dependencies: createdTasks.length - 1,
    }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/tasks/handoff error')
    return NextResponse.json({ error: 'Failed to create handoff chain' }, { status: 500 })
  }
}

/**
 * GET /api/tasks/handoff - List active handoff chains
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const db = getDatabase()
    const workspaceId = auth.user.workspace_id ?? 1

    // Find tasks that are part of chains (have handoff_chain in metadata)
    const chainTasks = db.prepare(`
      SELECT * FROM tasks 
      WHERE workspace_id = ? 
        AND metadata LIKE '%handoff_chain%'
      ORDER BY created_at ASC
    `).all(workspaceId) as Task[]

    // Group by chain name
    const chains = new Map<string, any[]>()
    for (const task of chainTasks) {
      const meta = task.metadata ? JSON.parse(task.metadata) : {}
      const chainName = meta.handoff_chain || 'Unknown'
      if (!chains.has(chainName)) chains.set(chainName, [])
      chains.get(chainName)!.push({
        ...task,
        tags: task.tags ? JSON.parse(task.tags) : [],
        metadata: meta,
      })
    }

    const result = Array.from(chains.entries()).map(([name, tasks]) => {
      const sorted = tasks.sort((a: any, b: any) => (a.metadata.chain_position || 0) - (b.metadata.chain_position || 0))
      const completed = sorted.filter((t: any) => ['done', 'review', 'quality_review'].includes(t.status)).length
      const total = sorted.length
      return {
        name,
        tasks: sorted,
        progress: { completed, total, percentage: Math.round((completed / total) * 100) },
        status: completed === total ? 'completed' : sorted.some((t: any) => t.status === 'in_progress') ? 'in_progress' : 'pending',
      }
    })

    return NextResponse.json({ chains: result })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/tasks/handoff error')
    return NextResponse.json({ error: 'Failed to fetch handoff chains' }, { status: 500 })
  }
}
