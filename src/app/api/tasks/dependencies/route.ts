import { NextRequest, NextResponse } from 'next/server'
import { getDatabase } from '@/lib/db'
import { requireRole } from '@/lib/auth'
import { logger } from '@/lib/logger'

/**
 * GET /api/tasks/dependencies - List task dependencies
 * Query params: task_id (parent), child_id, all
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const db = getDatabase()
    const { searchParams } = new URL(request.url)
    const workspaceId = auth.user.workspace_id ?? 1

    const taskId = searchParams.get('task_id')
    const childId = searchParams.get('child_id')

    let query = 'SELECT d.*, pt.title as parent_title, ct.title as child_title, ct.assigned_to as child_assigned_to FROM task_dependencies d LEFT JOIN tasks pt ON d.parent_task_id = pt.id LEFT JOIN tasks ct ON d.child_task_id = ct.id WHERE d.workspace_id = ?'
    const params: any[] = [workspaceId]

    if (taskId) {
      query += ' AND d.parent_task_id = ?'
      params.push(parseInt(taskId))
    }
    if (childId) {
      query += ' AND d.child_task_id = ?'
      params.push(parseInt(childId))
    }

    query += ' ORDER BY d.execution_order ASC, d.created_at ASC'

    const deps = db.prepare(query).all(...params)

    return NextResponse.json({ dependencies: deps })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/tasks/dependencies error')
    return NextResponse.json({ error: 'Failed to fetch dependencies' }, { status: 500 })
  }
}

/**
 * POST /api/tasks/dependencies - Create a task dependency (handoff link)
 * 
 * Body options:
 * 1. Link two existing tasks:
 *    { parent_task_id, child_task_id, execution_order? }
 * 
 * 2. Auto-create on completion (template):
 *    { parent_task_id, template_config: { title_template, description, assigned_to, priority, tags } }
 */
export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const db = getDatabase()
    const workspaceId = auth.user.workspace_id ?? 1
    const body = await request.json()
    const { parent_task_id, child_task_id, template_config, execution_order = 0 } = body

    if (!parent_task_id) {
      return NextResponse.json({ error: 'parent_task_id is required' }, { status: 400 })
    }

    // Verify parent exists
    const parent = db.prepare('SELECT id FROM tasks WHERE id = ? AND workspace_id = ?')
      .get(parent_task_id, workspaceId)
    if (!parent) {
      return NextResponse.json({ error: 'Parent task not found' }, { status: 404 })
    }

    // Verify child exists if specified
    if (child_task_id) {
      const child = db.prepare('SELECT id FROM tasks WHERE id = ? AND workspace_id = ?')
        .get(child_task_id, workspaceId)
      if (!child) {
        return NextResponse.json({ error: 'Child task not found' }, { status: 404 })
      }
      // Prevent circular deps
      if (child_task_id === parent_task_id) {
        return NextResponse.json({ error: 'Task cannot depend on itself' }, { status: 400 })
      }
    }

    if (!child_task_id && !template_config) {
      return NextResponse.json({ error: 'Either child_task_id or template_config is required' }, { status: 400 })
    }

    const result = db.prepare(`
      INSERT INTO task_dependencies (parent_task_id, child_task_id, template_config, execution_order, workspace_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      parent_task_id,
      child_task_id || null,
      template_config ? JSON.stringify(template_config) : null,
      execution_order,
      workspaceId
    )

    const dep = db.prepare('SELECT * FROM task_dependencies WHERE id = ?')
      .get(result.lastInsertRowid)

    return NextResponse.json({ dependency: dep }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/tasks/dependencies error')
    return NextResponse.json({ error: 'Failed to create dependency' }, { status: 500 })
  }
}

/**
 * DELETE /api/tasks/dependencies - Remove a dependency
 * Body: { id }
 */
export async function DELETE(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const db = getDatabase()
    const workspaceId = auth.user.workspace_id ?? 1
    const body = await request.json()
    const { id } = body

    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

    db.prepare('DELETE FROM task_dependencies WHERE id = ? AND workspace_id = ?')
      .run(id, workspaceId)

    return NextResponse.json({ success: true })
  } catch (error) {
    logger.error({ err: error }, 'DELETE /api/tasks/dependencies error')
    return NextResponse.json({ error: 'Failed to delete dependency' }, { status: 500 })
  }
}
