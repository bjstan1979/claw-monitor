# Claw-Monitor Harness Design

## Overview

Add a harness layer to claw-monitor that uses OpenClaw plugin SDK hooks (`before_tool_call`, `message_sending`, `before_prompt_build`) to move from passive polling to active event-driven monitoring. The harness evaluates rules in real-time and can block/approve tool calls, inject notifications, and append context to prompts.

## Architecture

All harness code lives in `index.js` (same file, same style as existing code). A separate `harness-rules.json` file holds the rule configuration. No new dependencies.

```
┌─────────────────────────────────────────────────┐
│                  index.js                        │
│                                                  │
│  ┌──────────┐  ┌──────────┐  ┌───────────────┐ │
│  │ Existing │  │ Harness  │  │ Harness Rule  │ │
│  │ Monitor  │  │ Hook     │  │ Evaluator     │ │
│  │ Loop     │  │ Handlers │  │               │ │
│  └────┬─────┘  └────┬─────┘  └───────┬───────┘ │
│       │             │                │          │
│       └─────────────┴────────────────┘          │
│                     │                            │
│            Shared State (module vars)            │
│            - sessionCache                        │
│            - checkpointState                     │
│            - harnessRuleConfig                   │
└─────────────────────────────────────────────────┘
                      │
          ┌───────────┴───────────┐
          │  harness-rules.json   │
          │  (rule definitions)   │
          └───────────────────────┘
```

## Hook Registrations

### 1. before_tool_call

**Purpose**: Evaluate tool calls against rules before execution. Can block, require approval, or modify params.

**Signature**: `(event: { toolName, params, runId?, toolCallId? }, ctx: { agentId?, sessionKey?, sessionId?, runId?, toolName, toolCallId?, getSessionExtension? }) → { block?, blockReason?, requireApproval?, params? } | void`

**Behavior**:
- Load rules from `harness-rules.json` filtered by agent role
- Evaluate conditions against current session state (contextUsage, toolCallCount, turnCount)
- Return values:
  - `{ block: true, blockReason: "..." }` — hard block
  - `{ requireApproval: { title, description, severity, timeoutMs, timeoutBehavior, onResolution } }` — soft gate
  - `{ params: modifiedParams }` — param rewrite
  - `void` — pass through

**Data sources**: ctx object for sessionKey/agentId, sessions.json cache for contextUsage, in-memory counters for toolCallCount/turnCount.

### 2. message_sending

**Purpose**: Inject urgent notifications into outgoing messages (task interruption, context overflow warnings).

**Signature**: `(event: { to, content, replyToId?, threadId?, metadata? }, ctx: { channelId, accountId?, conversationId?, sessionKey?, runId?, messageId?, senderId? }) → { content?, cancel? } | void`

**Behavior**:
- Check if there are pending urgent notifications for this session
- If yes, prepend notification to content with `[HARNESS]` prefix
- If the message itself is from a blocked operation, return `{ cancel: true }`
- Urgent notifications include: task interruption detected, context overflow imminent, critical rule violation

**Notification format**:
```
[HARNESS] ⚠️ Context usage at 85%. Consider wrapping up or switching to a sub-agent.
---
<original message content>
```

### 3. before_prompt_build

**Purpose**: Append routine monitoring context to the prompt (progress status, rule summaries, checkpoint hints).

**Signature**: `(event: { prompt, messages }, ctx: PluginHookAgentContext) → { prependContext?, appendContext? } | void`

**Behavior**:
- Return `{ appendContext: "..." }` with current monitoring state
- Content includes: current step progress, remaining steps, active checkpoint info
- Prefixed with `[HARNESS]` to distinguish from `[CLAW-MONITOR]` injections
- Only append when there's meaningful state to report (not every turn)

**Appended context format**:
```
[HARNESS] Progress: Step 3/5 (60%). Current phase: code implementation. Estimated remaining: 2 steps.
```

## Rule Engine

### Rule Configuration (harness-rules.json)

```json
{
  "version": 1,
  "defaultAction": "pass",
  "rules": [
    {
      "id": "context-overflow-warning",
      "name": "Context Overflow Warning",
      "agentRoles": ["main", "coder", "researcher"],
      "trigger": { "contextUsage": { "gt": 70 } },
      "action": "requireApproval",
      "actionConfig": {
        "title": "Context Usage High",
        "description": "Context usage is at {{contextUsage}}%. Consider wrapping up or delegating.",
        "severity": "warning",
        "timeoutMs": 30000,
        "timeoutBehavior": "allow"
      },
      "enabled": true
    },
    {
      "id": "context-overflow-block",
      "name": "Context Overflow Block",
      "agentRoles": ["main", "coder"],
      "trigger": { "contextUsage": { "gt": 90 } },
      "action": "block",
      "actionConfig": {
        "blockReason": "Context usage at {{contextUsage}}%. Task too large for single session. Please delegate to sub-agent."
      },
      "enabled": true
    },
    {
      "id": "tool-burst-protection",
      "name": "Tool Burst Protection",
      "agentRoles": ["main"],
      "trigger": { "toolCallCount": { "gt": 50 }, "timeWindowMinutes": 10 },
      "action": "requireApproval",
      "actionConfig": {
        "title": "High Tool Call Rate",
        "description": "{{toolCallCount}} tool calls in the last 10 minutes. Is this intentional?",
        "severity": "info",
        "timeoutMs": 15000,
        "timeoutBehavior": "allow"
      },
      "enabled": true
    }
  ]
}
```

### Rule Evaluation Logic

1. Filter rules by `agentRoles` (match current agent's role)
2. Filter by `enabled: true`
3. Evaluate trigger conditions against current session state
4. For matching rules, execute the configured action
5. Multiple matching rules: highest severity wins (block > requireApproval > pass)
6. Template variables `{{contextUsage}}`, `{{toolCallCount}}` etc. are interpolated at evaluation time

### Condition DSL

Simple comparison operators on numeric fields:
- `{ "gt": N }` — greater than
- `{ "lt": N }` — less than
- `{ "gte": N }` — greater than or equal
- `{ "lte": N }` — less than or equal
- `{ "eq": N }` — equals

Available fields: `contextUsage`, `toolCallCount`, `turnCount`, `sessionDurationMinutes`, `errorCount`.

### Tool Call Counting

`toolCallCount` is tracked per-session with a sliding time window. Each `before_tool_call` invocation appends a timestamp to an in-memory array. When evaluating a rule with `timeWindowMinutes`, only timestamps within the window are counted. The array is pruned on each evaluation to prevent unbounded growth. Rules without `timeWindowMinutes` use the total session count.

### Agent Role Resolution

The `ctx.agentId` from hook context is mapped to a role via the agents configuration in `openclaw.json`. The mapping reads `agents.list` entries and matches `agentId` to the agent's `role` field (defaults to `"main"` if not specified). This mapping is cached at startup and refreshed when the config changes.

## Data Flow

```
OpenClaw Gateway
    │
    ├─ before_tool_call ──→ loadRules() ──→ evaluateConditions() ──→ {block|requireApproval|pass}
    │                                                                    │
    │                                                    ┌───────────────┘
    │                                                    ▼
    │                                            updateSessionMetrics()
    │                                                    │
    ├─ message_sending ──→ checkUrgentNotifications() ──→ {content|cancel|void}
    │                                                    │
    ├─ before_prompt_build ──→ buildHarnessContext() ──→ {appendContext}
    │                                                    │
    └─ (existing monitor loop continues unchanged)      │
                                                         ▼
                                                  Shared State
                                                  - ruleConfig (from harness-rules.json)
                                                  - sessionMetrics (in-memory)
                                                  - pendingNotifications (in-memory)
```

## Integration with Existing Features

### Prefix Convention
- `[CLAW-MONITOR]` — existing monitor notifications (alerts, checkpoints, pipeline)
- `[HARNESS]` — new harness notifications (rule evaluations, context injections)

### No Override of Built-in Policies
The harness does not override OpenClaw's built-in `trustedToolPolicy`. It operates as an additional layer. If OpenClaw already blocks a tool, the harness hook won't even fire.

### Checkpoint Enhancement
The harness uses existing checkpoint state to determine:
- Whether a session was interrupted (for `message_sending` urgent notifications)
- Current step progress (for `before_prompt_build` context)

### Alert Coexistence
Existing alert checks continue running in the monitor loop. The harness adds hook-based checks that fire in real-time. Both can produce notifications — the harness uses `[HARNESS]` prefix to avoid confusion.

## Phase 1 Default Rules

Phase 1 ships with conservative defaults — all rules use `requireApproval` (not `block`), allowing data collection before tightening:

1. **context-overflow-warning** — contextUsage > 70% → requireApproval
2. **tool-burst-protection** — toolCallCount > 50 in 10min → requireApproval
3. **long-session-check** — sessionDurationMinutes > 60 → requireApproval

After accumulating data, rules can be upgraded to `block` or adjusted thresholds via `harness-rules.json`.

## Error Handling

- If `harness-rules.json` is missing or malformed, harness hooks return `void` (pass-through) and log a warning
- If sessions.json cache is stale, use last known values with a staleness indicator
- If rule evaluation throws, catch and return `void` (never crash the gateway)
- Hook handlers must be synchronous or return promises promptly (no long-running operations)

## Testing Strategy

- Unit tests for rule evaluator (condition DSL, action selection, template interpolation)
- Integration test: load harness-rules.json, verify hook registration
- Manual test: trigger context overflow scenario, verify requireApproval fires
- Manual test: verify `[HARNESS]` prefix appears in injected content, not `[CLAW-MONITOR]`
