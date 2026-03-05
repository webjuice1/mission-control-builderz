# Agent-to-Agent Communication & Orchestration

## Overview

Mission Control supports three levels of agent orchestration:

1. **Direct messaging** — agents send messages to each other
2. **Task handoffs** — completing a task auto-triggers the next agent's task
3. **Pipelines** — workflow templates chained into multi-step sequences

---

## 1. Agent-to-Agent Messaging

### Send a message between agents
```
POST /api/agents/message
{
  "from": "leo",
  "to": "luna",
  "message": "SEO audit is done. Key findings: title tags need updating on 12 pages."
}
```

### Send via the chat system (appears in Agent Comms panel)
```
POST /api/chat/messages
{
  "from": "leo",
  "to": "luna",
  "content": "Handing off SEO findings for content creation",
  "message_type": "text",
  "conversation_id": "a2a:leo:luna"
}
```

### View inter-agent communications
```
GET /api/agents/comms?agent=leo&limit=50
```

Returns messages, communication graph, and per-agent stats.

### UI

The **Agent Comms** panel (`#agent-comms`) shows:
- **Chat view**: Slack-like timeline of agent messages with @mentions
- **Graph view**: Communication volume between agents
- **Composer**: Send messages as coordinator or simulate agent-to-agent

---

## 2. Task Queue (Agent Polling)

Agents poll for their next task:

### Poll for next task
```
GET /api/tasks/queue?agent=leo
```

Returns the highest-priority assigned/inbox task for that agent.

### Poll and auto-claim
```
GET /api/tasks/queue?agent=leo&claim=true
```

Moves the task to `in_progress` automatically.

### Complete a task (with handoff trigger)
```
POST /api/tasks/queue
{
  "task_id": 42,
  "agent": "leo",
  "status": "review",
  "output": "Audit complete. Found 15 issues...",
  "trigger_next": true
}
```

When `trigger_next: true`, the system checks `task_dependencies` and:
- Unblocks any child tasks (moves from `blocked` → `assigned`)
- Sends handoff notification to the next agent
- Creates an inter-agent message in the comms feed
- If a template_config exists, auto-creates a new task

---

## 3. Task Dependencies & Handoffs

### Create a dependency between existing tasks
```
POST /api/tasks/dependencies
{
  "parent_task_id": 42,
  "child_task_id": 43
}
```

When task 42 completes → task 43 is unblocked.

### Auto-create task on completion
```
POST /api/tasks/dependencies
{
  "parent_task_id": 42,
  "template_config": {
    "title_template": "Content for: {parent_title}",
    "description": "Create content based on SEO findings",
    "assigned_to": "luna",
    "priority": "high",
    "tags": ["content", "seo-followup"]
  }
}
```

When task 42 completes → a new task is auto-created and assigned to Luna.

### List dependencies
```
GET /api/tasks/dependencies?task_id=42
```

---

## 4. Handoff Chains (Quick Pipeline)

Create a full task chain in one call:

```
POST /api/tasks/handoff
{
  "name": "SEO → Content → Social",
  "tasks": [
    {
      "title": "SEO Audit for ClientX",
      "assigned_to": "leo",
      "priority": "high",
      "description": "Full technical SEO audit"
    },
    {
      "title": "Write blog posts from SEO findings",
      "assigned_to": "luna",
      "priority": "high",
      "description": "Create content targeting identified keywords"
    },
    {
      "title": "Create social posts from blog content",
      "assigned_to": "sage",
      "priority": "medium",
      "description": "Repurpose blog content for social channels"
    }
  ]
}
```

This creates:
- Task 1 (leo): status `assigned` — ready to work
- Task 2 (luna): status `blocked` — waiting on task 1
- Task 3 (sage): status `blocked` — waiting on task 2
- Auto-dependencies between consecutive tasks
- Notification messages to all agents about the chain

### View active chains
```
GET /api/tasks/handoff
```

Returns chains grouped by name with progress tracking.

---

## 5. Workflow Pipelines (Template-Based)

For reusable multi-step workflows using workflow templates:

### Create workflow templates
```
POST /api/workflows
{
  "name": "SEO Audit",
  "task_prompt": "Perform a comprehensive SEO audit...",
  "model": "sonnet",
  "agent_role": "seo",
  "timeout_seconds": 600
}
```

### Create a pipeline from templates
```
POST /api/pipelines
{
  "name": "Full SEO-to-Social Pipeline",
  "description": "Leo audits → Luna writes → Sage posts",
  "steps": [
    { "template_id": 1, "on_failure": "stop" },
    { "template_id": 2, "on_failure": "stop" },
    { "template_id": 3, "on_failure": "continue" }
  ]
}
```

### Run a pipeline
```
POST /api/pipelines/run
{
  "action": "start",
  "pipeline_id": 1
}
```

### Advance to next step
```
POST /api/pipelines/run
{
  "action": "advance",
  "run_id": 1,
  "success": true
}
```

### Cancel a run
```
POST /api/pipelines/run
{
  "action": "cancel",
  "run_id": 1
}
```

---

## Agent Roles (Webjuice Swarm)

| Agent | Role | Emoji |
|-------|------|-------|
| Leo | SEO Specialist | 🦁 |
| Luna | Content Writer | 🌙 |
| Sage | Social Media | 🌿 |
| Nova | Web Developer | ⭐ |
| Aegis | Quality Reviewer | 🛡️ |

---

## Example: Full Leo → Luna → Sage Workflow

### Option A: Quick handoff chain
```bash
curl -X POST http://localhost:3000/api/tasks/handoff \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Q1 Blog Series",
    "tasks": [
      {"title": "SEO keyword research for Q1", "assigned_to": "leo", "priority": "high"},
      {"title": "Write 5 blog posts from keywords", "assigned_to": "luna", "priority": "high"},
      {"title": "Create social campaign for blogs", "assigned_to": "sage", "priority": "medium"}
    ]
  }'
```

### Option B: Agent polls and completes
```bash
# Leo polls for work
curl "http://localhost:3000/api/tasks/queue?agent=leo&claim=true"

# Leo completes and triggers Luna
curl -X POST http://localhost:3000/api/tasks/queue \
  -d '{"task_id": 1, "agent": "leo", "output": "Found 20 target keywords...", "trigger_next": true}'

# Luna polls for work (now unblocked)
curl "http://localhost:3000/api/tasks/queue?agent=luna&claim=true"

# Luna completes and triggers Sage
curl -X POST http://localhost:3000/api/tasks/queue \
  -d '{"task_id": 2, "agent": "luna", "output": "5 blog posts written...", "trigger_next": true}'
```

### What happens automatically:
1. Leo completes → Luna's task moves from `blocked` to `assigned`
2. Luna gets a notification: "SEO keyword research is done → your task is ready"
3. A handoff message appears in the Agent Comms panel
4. Luna completes → Sage's task is unblocked, same flow

---

## Task Board

The task board now includes a **Blocked** column showing tasks waiting on dependencies. Tasks move: `blocked` → `assigned` → `in_progress` → `review` → `quality_review` → `done`.

## Status Flow

```
inbox → assigned → in_progress → review → quality_review → done
                                    ↑
blocked ─────────────────────────────┘
(auto-unblocked when parent task completes)
```
