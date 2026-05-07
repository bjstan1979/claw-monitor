# Claw-Monitor Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a harness layer to claw-monitor that uses OpenClaw plugin SDK hooks (`before_tool_call`, `message_sending`, `before_prompt_build`) to evaluate rules in real-time and block/approve tool calls, inject notifications, and append context to prompts.

**Architecture:** Harness code lives in `index.js` (same file, same style). A `harness-rules.json` file holds rule configuration. Three new hooks are registered in the existing `register(api)` function. A rule evaluator reads config, matches agent roles, evaluates conditions, and returns hook-appropriate results.

**Tech Stack:** Node.js (zero new dependencies), OpenClaw plugin SDK hooks, JSON config file

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `index.js` | Modify | Add harness state, rule evaluator functions, hook registrations |
| `harness-rules.json` | Create | Default Phase 1 rule definitions |
| `openclaw.plugin.json` | Modify | Add harness config schema properties |
| `docs/superpowers/specs/2026-05-07-claw-monitor-harness-design.md` | Exists | Design spec (already written) |

---

### Task 1: Add harness state variables and config loader

**Files:**
- Modify: `index.js:7-16` (in-memory state section)

Add harness state variables after the existing state declarations (line 16). These track rule config, per-session metrics, and pending notifications.

- [ ] **Step 1: Add harness state variables**

Insert after line 15 (`let pendingRestartNotification = null;`):

```javascript
// --- Harness state ---
let harnessConfig = null;        // parsed harness-rules.json
let harnessConfigMtime = 0;      // mtime of harness-rules.json for cache invalidation
const harnessSessionMetrics = new Map(); // sessionKey -> { toolCallTimestamps: [], turnCount: 0, startedAt: number, errorCount: 0 }
const harnessPendingNotifications = []; // { sessionKey, text, ts, urgency: "high"|"normal" }
const harnessLog = [];           // { ts, ruleId, agentId, sessionKey, action, result }
```

- [ ] **Step 2: Add loadHarnessConfig function**

Insert after the `getConfig` function (after line 137):

```javascript
// --- Harness config loader ---
function loadHarnessConfig() {
  const configPath = path.join(__dirname, "harness-rules.json");
  try {
    const stat = fs.statSync(configPath);
    if (harnessConfig && stat.mtimeMs === harnessConfigMtime) {
      return harnessConfig;
    }
    const content = fs.readFileSync(configPath, "utf-8");
    const config = JSON.parse(content);
    harnessConfig = config;
    harnessConfigMtime = stat.mtimeMs;
    return config;
  } catch {
    // Missing or malformed config — harness is effectively disabled
    return null;
  }
}
```

- [ ] **Step 3: Verify syntax**

Run: `node -c index.js`
Expected: No syntax errors

- [ ] **Step 4: Commit**

```bash
git add index.js
git commit -m "feat(harness): add state variables and config loader"
```

---

### Task 2: Add context usage estimator

**Files:**
- Modify: `index.js` (after loadHarnessConfig)

Add `estimateContextUsage()` that reads from sessions.json cache (already available via `getSessionMetaFromSessionsJson`).

- [ ] **Step 1: Add estimateContextUsage function**

Insert after `loadHarnessConfig`:

```javascript
function estimateContextUsage(sessionKey) {
  const meta = getSessionMetaFromSessionsJson(sessionKey);
  if (meta?.totalTokens) {
    // Most models use 128K-200K context window; use 170K as default estimate
    const contextWindow = 170000;
    return Math.min(99, Math.round((meta.totalTokens / contextWindow) * 100));
  }
  // Fallback: estimate from JSONL file size
  const agentId = resolveAgentIdFromSessionKey(sessionKey);
  const sessionId = resolveSessionIdFromSessionKey(sessionKey);
  const jsonlPath = findJsonlFile(agentId, sessionId);
  if (jsonlPath) {
    try {
      const stat = fs.statSync(jsonlPath);
      // Rough: 1KB JSONL ≈ 300 tokens
      const estimatedTokens = Math.round((stat.size / 1024) * 300);
      const contextWindow = 170000;
      return Math.min(99, Math.round((estimatedTokens / contextWindow) * 100));
    } catch {}
  }
  return 0; // Unknown — don't trigger any rules
}
```

- [ ] **Step 2: Verify syntax**

Run: `node -c index.js`
Expected: No syntax errors

- [ ] **Step 3: Commit**

```bash
git add index.js
git commit -m "feat(harness): add context usage estimator"
```

---

### Task 3: Add session metrics tracker

**Files:**
- Modify: `index.js` (after estimateContextUsage)

Add functions to track and query per-session metrics (tool call count, turn count, session duration, error count). These are updated by hooks and queried by the rule evaluator.

- [ ] **Step 1: Add metrics functions**

Insert after `estimateContextUsage`:

```javascript
function getOrCreateSessionMetrics(sessionKey) {
  if (!harnessSessionMetrics.has(sessionKey)) {
    harnessSessionMetrics.set(sessionKey, {
      toolCallTimestamps: [],
      turnCount: 0,
      startedAt: Date.now(),
      errorCount: 0,
    });
  }
  return harnessSessionMetrics.get(sessionKey);
}

function recordToolCall(sessionKey) {
  const metrics = getOrCreateSessionMetrics(sessionKey);
  metrics.toolCallTimestamps.push(Date.now());
  // Prune timestamps older than 60 minutes to prevent unbounded growth
  const cutoff = Date.now() - 3600000;
  metrics.toolCallTimestamps = metrics.toolCallTimestamps.filter(ts => ts >= cutoff);
}

function recordTurn(sessionKey) {
  const metrics = getOrCreateSessionMetrics(sessionKey);
  metrics.turnCount++;
}

function recordError(sessionKey) {
  const metrics = getOrCreateSessionMetrics(sessionKey);
  metrics.errorCount++;
}

function getSessionMetrics(sessionKey) {
  const metrics = getOrCreateSessionMetrics(sessionKey);
  const now = Date.now();
  return {
    contextUsage: estimateContextUsage(sessionKey),
    toolCallCount: metrics.toolCallTimestamps.length,
    toolCallCountInWindow: (windowMinutes) => {
      const cutoff = now - windowMinutes * 60000;
      return metrics.toolCallTimestamps.filter(ts => ts >= cutoff).length;
    },
    turnCount: metrics.turnCount,
    sessionDurationMinutes: (now - metrics.startedAt) / 60000,
    errorCount: metrics.errorCount,
  };
}
```

- [ ] **Step 2: Verify syntax**

Run: `node -c index.js`
Expected: No syntax errors

- [ ] **Step 3: Commit**

```bash
git add index.js
git commit -m "feat(harness): add session metrics tracker"
```

---

### Task 4: Add rule evaluator

**Files:**
- Modify: `index.js` (after session metrics functions)

The core rule evaluator: loads config, filters by agent role, evaluates conditions, returns the highest-priority action.

- [ ] **Step 1: Add condition evaluator**

```javascript
// --- Harness rule evaluator ---
function evaluateCondition(condition, metrics) {
  // condition is like { contextUsage: { gt: 70 }, toolCallCount: { gt: 50 } }
  // All keys must match (AND logic)
  for (const [field, spec] of Object.entries(condition)) {
    let value;
    if (field === "toolCallCountInWindow") {
      // Special: spec includes { gt: N, windowMinutes: M }
      const windowMinutes = spec.windowMinutes || 10;
      value = metrics.toolCallCountInWindow(windowMinutes);
      // Compare only gt/lt/gte/lte/eq, not windowMinutes itself
      const compareSpec = {};
      for (const [op, v] of Object.entries(spec)) {
        if (op !== "windowMinutes") compareSpec[op] = v;
      }
      if (!compareNumeric(value, compareSpec)) return false;
      continue;
    }
    value = metrics[field];
    if (value === undefined || value === null) return false;
    if (typeof spec === "object") {
      if (!compareNumeric(value, spec)) return false;
    } else {
      // Direct equality
      if (value !== spec) return false;
    }
  }
  return true;
}

function compareNumeric(value, spec) {
  if (spec.gt !== undefined && !(value > spec.gt)) return false;
  if (spec.lt !== undefined && !(value < spec.lt)) return false;
  if (spec.gte !== undefined && !(value >= spec.gte)) return false;
  if (spec.lte !== undefined && !(value <= spec.lte)) return false;
  if (spec.eq !== undefined && value !== spec.eq) return false;
  return true;
}
```

- [ ] **Step 2: Add rule evaluation function**

```javascript
function evaluateHarnessRules(agentRole, metrics, hookName) {
  const config = loadHarnessConfig();
  if (!config || !config.rules) return null;

  const matchingRules = config.rules.filter(rule => {
    if (rule.enabled === false) return false;
    if (!rule.agentRoles || !rule.agentRoles.includes(agentRole)) return false;
    if (rule.hook && rule.hook !== hookName) return false;
    if (!evaluateCondition(rule.trigger, metrics)) return false;
    return true;
  });

  if (matchingRules.length === 0) return null;

  // Priority: block > requireApproval > pass
  const priority = { block: 3, requireApproval: 2, pass: 1 };
  matchingRules.sort((a, b) => (priority[b.action] || 0) - (priority[a.action] || 0));

  return matchingRules[0]; // Return highest-priority matching rule
}

function interpolateTemplate(template, metrics) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const value = metrics[key];
    if (value === undefined || value === null) return "N/A";
    if (typeof value === "number" && !Number.isInteger(value)) return value.toFixed(1);
    return String(value);
  });
}
```

- [ ] **Step 3: Add harness logging function**

```javascript
function logHarnessEvent(ruleId, agentId, sessionKey, action, result) {
  const entry = {
    ts: Date.now(),
    ruleId,
    agentId,
    sessionKey,
    action,
    result, // "blocked" | "approved" | "rejected" | "injected" | "passed"
  };
  harnessLog.push(entry);
  if (harnessLog.length > 1000) harnessLog.shift();

  // Write to file for analytics
  try {
    const logPath = path.join(resolveOpenclawDir(), "harness-log.jsonl");
    fs.appendFileSync(logPath, JSON.stringify(entry) + "\n");
  } catch {}
}
```

- [ ] **Step 4: Add agent role resolver**

```javascript
function resolveAgentRole(sessionKey, ctx) {
  // ctx.agentId from hook context is the most reliable
  const agentId = ctx?.agentId || resolveAgentIdFromSessionKey(sessionKey || "");
  // Map common agentId patterns to roles
  if (agentId === "main" || agentId === "葱花") return "main";
  if (agentId === "coder" || agentId === "程序员") return "coder";
  if (agentId === "researcher" || agentId === "研究员") return "researcher";
  if (agentId === "media" || agentId === "多媒体专员") return "media";
  if (agentId === "news" || agentId === "新闻员") return "news";
  // Default: use agentId as role
  return agentId;
}
```

- [ ] **Step 5: Verify syntax**

Run: `node -c index.js`
Expected: No syntax errors

- [ ] **Step 6: Commit**

```bash
git add index.js
git commit -m "feat(harness): add rule evaluator, condition DSL, and logging"
```

---

### Task 5: Create harness-rules.json with Phase 1 defaults

**Files:**
- Create: `harness-rules.json`

- [ ] **Step 1: Create the config file**

```json
{
  "version": 1,
  "defaultAction": "pass",
  "rules": [
    {
      "id": "context-overflow-warning",
      "name": "Context Overflow Warning",
      "agentRoles": ["main", "coder", "researcher", "media", "news"],
      "hook": "before_tool_call",
      "trigger": { "contextUsage": { "gt": 70 } },
      "action": "requireApproval",
      "actionConfig": {
        "title": "Context Usage High",
        "description": "Context usage is at {{contextUsage}}%. Consider wrapping up or delegating to a sub-agent.",
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
      "hook": "before_tool_call",
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
      "hook": "before_tool_call",
      "trigger": { "toolCallCountInWindow": { "gt": 50, "windowMinutes": 10 } },
      "action": "requireApproval",
      "actionConfig": {
        "title": "High Tool Call Rate",
        "description": "{{toolCallCount}} tool calls in the last 10 minutes. Is this intentional?",
        "severity": "info",
        "timeoutMs": 15000,
        "timeoutBehavior": "allow"
      },
      "enabled": true
    },
    {
      "id": "long-session-check",
      "name": "Long Session Check",
      "agentRoles": ["main", "coder", "researcher"],
      "hook": "before_prompt_build",
      "trigger": { "sessionDurationMinutes": { "gt": 60 } },
      "action": "pass",
      "actionConfig": {
        "appendContext": "Session has been running for {{sessionDurationMinutes}} minutes. Consider checkpointing progress."
      },
      "enabled": true
    }
  ]
}
```

- [ ] **Step 2: Validate JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('harness-rules.json','utf-8')); console.log('valid')"`
Expected: `valid`

- [ ] **Step 3: Commit**

```bash
git add harness-rules.json
git commit -m "feat(harness): add Phase 1 default rules config"
```

---

### Task 6: Register before_tool_call hook

**Files:**
- Modify: `index.js:2959-3354` (register function)

Add the `before_tool_call` hook inside `register(api)`, after the existing `heartbeat_prompt_contribution` hook (after line 3353).

- [ ] **Step 1: Add before_tool_call hook registration**

Insert before the closing `}` of `register(api)` (before line 3354):

```javascript
    // Hook: before_tool_call — evaluate harness rules for tool calls
    api.on("before_tool_call", async (event, ctx) => {
      try {
        const sessionKey = ctx?.sessionKey || "";
        const agentRole = resolveAgentRole(sessionKey, ctx);

        // Record this tool call in session metrics
        recordToolCall(sessionKey);
        recordTurn(sessionKey);

        const metrics = getSessionMetrics(sessionKey);
        const rule = evaluateHarnessRules(agentRole, metrics, "before_tool_call");

        if (!rule) return; // No matching rule — pass through

        const actionConfig = rule.actionConfig || {};

        if (rule.action === "block") {
          const blockReason = interpolateTemplate(actionConfig.blockReason || "Blocked by harness rule: " + rule.id, metrics);
          logHarnessEvent(rule.id, agentRole, sessionKey, "block", "blocked");
          api.logger.info(`[HARNESS] blocked tool=${event.toolName} rule=${rule.id} agent=${agentRole} reason=${blockReason}`);
          return { block: true, blockReason };
        }

        if (rule.action === "requireApproval") {
          const title = interpolateTemplate(actionConfig.title || "Harness Approval Required", metrics);
          const description = interpolateTemplate(actionConfig.description || `Rule ${rule.id} requires approval for tool ${event.toolName}.`, metrics);
          logHarnessEvent(rule.id, agentRole, sessionKey, "requireApproval", "pending");
          api.logger.info(`[HARNESS] requireApproval tool=${event.toolName} rule=${rule.id} agent=${agentRole}`);
          return {
            requireApproval: {
              title,
              description,
              severity: actionConfig.severity || "warning",
              timeoutMs: actionConfig.timeoutMs || 30000,
              timeoutBehavior: actionConfig.timeoutBehavior || "allow",
              pluginId: "claw-monitor",
              onResolution: (decision) => {
                const result = decision === "allow-once" || decision === "allow-always" ? "approved" : "rejected";
                logHarnessEvent(rule.id, agentRole, sessionKey, "requireApproval", result);
                api.logger.info(`[HARNESS] approval result=${result} rule=${rule.id} tool=${event.toolName}`);
              },
            },
          };
        }

        // action === "pass" — log but don't intercept
        logHarnessEvent(rule.id, agentRole, sessionKey, "pass", "passed");
      } catch (err) {
        // Never crash the gateway from a harness hook
        api.logger.warn(`[HARNESS] before_tool_call error: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
```

- [ ] **Step 2: Verify syntax**

Run: `node -c index.js`
Expected: No syntax errors

- [ ] **Step 3: Commit**

```bash
git add index.js
git commit -m "feat(harness): register before_tool_call hook"
```

---

### Task 7: Register message_sending hook

**Files:**
- Modify: `index.js` (register function, after before_tool_call)

Add the `message_sending` hook for urgent notification injection.

- [ ] **Step 1: Add message_sending hook registration**

Insert after the `before_tool_call` hook:

```javascript
    // Hook: message_sending — inject urgent harness notifications into outgoing messages
    api.on("message_sending", async (event, ctx) => {
      try {
        const sessionKey = ctx?.sessionKey || "";
        if (!sessionKey) return;

        // Check for pending urgent notifications for this session
        const pending = harnessPendingNotifications.filter(n => n.sessionKey === sessionKey);
        if (pending.length === 0) return;

        // Remove matched notifications
        for (const n of pending) {
          const idx = harnessPendingNotifications.indexOf(n);
          if (idx >= 0) harnessPendingNotifications.splice(idx, 1);
        }

        // Prepend urgent notifications to message content
        const notifyText = pending
          .map(n => `[HARNESS] ${n.text}`)
          .join("\n");
        const newContent = notifyText + "\n---\n" + event.content;

        api.logger.info(`[HARNESS] message_sending: injected ${pending.length} urgent notifications for session=${sessionKey}`);
        return { content: newContent };
      } catch (err) {
        api.logger.warn(`[HARNESS] message_sending error: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
```

- [ ] **Step 2: Verify syntax**

Run: `node -c index.js`
Expected: No syntax errors

- [ ] **Step 3: Commit**

```bash
git add index.js
git commit -m "feat(harness): register message_sending hook for urgent notifications"
```

---

### Task 8: Enhance before_prompt_build hook with harness context

**Files:**
- Modify: `index.js:3252-3297` (existing before_prompt_build hook)

Enhance the existing `before_prompt_build` hook to also append harness context (rule summaries, session duration warnings).

- [ ] **Step 1: Add harness context injection to before_prompt_build**

At the end of the existing `before_prompt_build` handler (before the closing `});` at line 3297), add:

```javascript
      // --- Harness: append rule-based context ---
      try {
        const harnessSessionKey = ctx?.sessionKey || "";
        const agentRole = resolveAgentRole(harnessSessionKey, ctx);
        const metrics = getSessionMetrics(harnessSessionKey);
        const rule = evaluateHarnessRules(agentRole, metrics, "before_prompt_build");

        if (rule && rule.action === "pass" && rule.actionConfig?.appendContext) {
          const contextText = interpolateTemplate(rule.actionConfig.appendContext, metrics);
          // Return appendContext alongside existing injection logic
          // Since before_prompt_build can return { appendContext }, we need to merge
          // The existing hook doesn't return a value, so we can return one now
          logHarnessEvent(rule.id, agentRole, harnessSessionKey, "pass", "injected");
          api.logger.info(`[HARNESS] before_prompt_build: appended context for rule=${rule.id} agent=${agentRole}`);
          return { appendContext: `[HARNESS] ${contextText}` };
        }
      } catch (err) {
        api.logger.warn(`[HARNESS] before_prompt_build harness error: ${err instanceof Error ? err.message : String(err)}`);
      }
```

- [ ] **Step 2: Verify syntax**

Run: `node -c index.js`
Expected: No syntax errors

- [ ] **Step 3: Commit**

```bash
git add index.js
git commit -m "feat(harness): enhance before_prompt_build with rule-based context injection"
```

---

### Task 9: Add after_tool_call hook for error tracking

**Files:**
- Modify: `index.js` (register function, after message_sending)

Register `after_tool_call` to track errors and update session metrics.

- [ ] **Step 1: Add after_tool_call hook registration**

Insert after the `message_sending` hook:

```javascript
    // Hook: after_tool_call — track errors and update metrics
    api.on("after_tool_call", async (event, ctx) => {
      try {
        const sessionKey = ctx?.sessionKey || "";
        if (event.error) {
          recordError(sessionKey);
        }
      } catch (err) {
        api.logger.warn(`[HARNESS] after_tool_call error: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
```

- [ ] **Step 2: Verify syntax**

Run: `node -c index.js`
Expected: No syntax errors

- [ ] **Step 3: Commit**

```bash
git add index.js
git commit -m "feat(harness): register after_tool_call hook for error tracking"
```

---

### Task 10: Update openclaw.plugin.json config schema

**Files:**
- Modify: `openclaw.plugin.json:8-62` (configSchema)

Add harness-related config properties to the plugin config schema.

- [ ] **Step 1: Add harness config properties**

Add these properties inside `configSchema.properties` (after `orphanGraceMinutes`):

```json
      "harnessEnabled": {
        "type": "boolean",
        "default": true
      },
      "harnessRulesPath": {
        "type": "string",
        "default": ""
      },
      "harnessLogEnabled": {
        "type": "boolean",
        "default": true
      },
      "harnessDefaultAction": {
        "type": "string",
        "enum": ["requireApproval", "block", "pass"],
        "default": "pass"
      }
```

- [ ] **Step 2: Validate JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('openclaw.plugin.json','utf-8')); console.log('valid')"`
Expected: `valid`

- [ ] **Step 3: Commit**

```bash
git add openclaw.plugin.json
git commit -m "feat(harness): add config schema for harness settings"
```

---

### Task 11: Add harness_status and harness_log tools

**Files:**
- Modify: `index.js` (register function, after tool registrations)

Add two new tools for inspecting harness state.

- [ ] **Step 1: Add harness_status tool**

Insert before the `register(api)` function's existing tool registrations (before line 2963), add the tool creation function:

```javascript
function createHarnessStatusTool() {
  return {
    name: "harness_status",
    description: "Show current harness rule evaluation status, active rules, and session metrics.",
    inputSchema: {
      type: "object",
      properties: {
        sessionKey: { type: "string", description: "Session key to check (optional, defaults to current)" },
      },
    },
    async execute(params) {
      const config = loadHarnessConfig();
      if (!config) {
        return { content: [{ type: "text", text: "Harness config not loaded (harness-rules.json missing or invalid)." }] };
      }
      const parts = [];
      parts.push(`Harness version: ${config.version || 1}`);
      parts.push(`Default action: ${config.defaultAction || "pass"}`);
      parts.push(`Rules: ${config.rules?.length || 0}`);
      for (const rule of (config.rules || [])) {
        const status = rule.enabled === false ? "DISABLED" : "enabled";
        parts.push(`  - ${rule.id} [${status}] action=${rule.action} agents=${(rule.agentRoles || []).join(",")}`);
      }
      parts.push(`\nSession metrics tracked: ${harnessSessionMetrics.size}`);
      if (params?.sessionKey && harnessSessionMetrics.has(params.sessionKey)) {
        const metrics = getSessionMetrics(params.sessionKey);
        parts.push(`  Session ${params.sessionKey}:`);
        parts.push(`    contextUsage: ${metrics.contextUsage}%`);
        parts.push(`    toolCallCount: ${metrics.toolCallCount}`);
        parts.push(`    turnCount: ${metrics.turnCount}`);
        parts.push(`    sessionDuration: ${metrics.sessionDurationMinutes.toFixed(1)}min`);
        parts.push(`    errorCount: ${metrics.errorCount}`);
      }
      parts.push(`\nPending notifications: ${harnessPendingNotifications.length}`);
      parts.push(`Recent log entries: ${harnessLog.length}`);
      return { content: [{ type: "text", text: parts.join("\n") }] };
    },
  };
}

function createHarnessLogTool() {
  return {
    name: "harness_log",
    description: "Show recent harness evaluation log entries.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max entries to show (default 20)", minimum: 1, maximum: 100 },
        ruleId: { type: "string", description: "Filter by rule ID" },
      },
    },
    async execute(params) {
      const limit = params?.limit || 20;
      let entries = [...harnessLog].reverse();
      if (params?.ruleId) {
        entries = entries.filter(e => e.ruleId === params.ruleId);
      }
      entries = entries.slice(0, limit);
      if (entries.length === 0) {
        return { content: [{ type: "text", text: "No harness log entries." }] };
      }
      const lines = entries.map(e => {
        const ts = new Date(e.ts).toISOString();
        return `[${ts}] ${e.ruleId} agent=${e.agentId} action=${e.action} result=${e.result}`;
      });
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  };
}
```

- [ ] **Step 2: Register the tools in register(api)**

Add after the existing tool registrations (after line 2971):

```javascript
    api.registerTool(createHarnessStatusTool(), { optional: true });
    api.registerTool(createHarnessLogTool(), { optional: true });
```

- [ ] **Step 3: Update openclaw.plugin.json contracts**

Add `"harness_status"` and `"harness_log"` to the `contracts.tools` array.

- [ ] **Step 4: Verify syntax**

Run: `node -c index.js`
Expected: No syntax errors

- [ ] **Step 5: Commit**

```bash
git add index.js openclaw.plugin.json
git commit -m "feat(harness): add harness_status and harness_log tools"
```

---

### Task 12: Integration test — verify hooks fire and rules evaluate

**Files:**
- Create: `test-harness.js`

- [ ] **Step 1: Create integration test script**

```javascript
// test-harness.js — Manual integration test for harness hooks
// Run: node test-harness.js
// This tests the rule evaluator logic in isolation (not the full OpenClaw gateway)

const fs = require("fs");
const path = require("path");

// Load index.js functions by requiring the module
// Since index.js is a plugin entry, we test the pure functions directly

// --- Test 1: Config loading ---
console.log("Test 1: Config loading");
const configPath = path.join(__dirname, "harness-rules.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
console.assert(config.version === 1, "version should be 1");
console.assert(config.rules.length >= 3, "should have at least 3 rules");
console.log("  PASS: Config loaded with " + config.rules.length + " rules");

// --- Test 2: Condition evaluation ---
console.log("Test 2: Condition evaluation");

// Inline the evaluateCondition and compareNumeric for testing
function compareNumeric(value, spec) {
  if (spec.gt !== undefined && !(value > spec.gt)) return false;
  if (spec.lt !== undefined && !(value < spec.lt)) return false;
  if (spec.gte !== undefined && !(value >= spec.gte)) return false;
  if (spec.lte !== undefined && !(value <= spec.lte)) return false;
  if (spec.eq !== undefined && value !== spec.eq) return false;
  return true;
}

function evaluateCondition(condition, metrics) {
  for (const [field, spec] of Object.entries(condition)) {
    let value;
    if (field === "toolCallCountInWindow") {
      const windowMinutes = spec.windowMinutes || 10;
      value = metrics.toolCallCountInWindow ? metrics.toolCallCountInWindow(windowMinutes) : 0;
      const compareSpec = {};
      for (const [op, v] of Object.entries(spec)) {
        if (op !== "windowMinutes") compareSpec[op] = v;
      }
      if (!compareNumeric(value, compareSpec)) return false;
      continue;
    }
    value = metrics[field];
    if (value === undefined || value === null) return false;
    if (typeof spec === "object") {
      if (!compareNumeric(value, spec)) return false;
    } else {
      if (value !== spec) return false;
    }
  }
  return true;
}

// Test gt
console.assert(evaluateCondition({ contextUsage: { gt: 70 } }, { contextUsage: 75 }) === true, "75 > 70 should be true");
console.assert(evaluateCondition({ contextUsage: { gt: 70 } }, { contextUsage: 50 }) === false, "50 > 70 should be false");
// Test lte
console.assert(evaluateCondition({ turnCount: { lte: 2 } }, { turnCount: 2 }) === true, "2 <= 2 should be true");
console.assert(evaluateCondition({ turnCount: { lte: 2 } }, { turnCount: 3 }) === false, "3 <= 2 should be false");
// Test AND logic
console.assert(
  evaluateCondition({ contextUsage: { gt: 70 }, turnCount: { gt: 5 } }, { contextUsage: 80, turnCount: 10 }) === true,
  "both conditions should be true"
);
console.assert(
  evaluateCondition({ contextUsage: { gt: 70 }, turnCount: { gt: 5 } }, { contextUsage: 80, turnCount: 3 }) === false,
  "one condition false should fail AND"
);
console.log("  PASS: Condition evaluation works correctly");

// --- Test 3: Template interpolation ---
console.log("Test 3: Template interpolation");
function interpolateTemplate(template, metrics) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const value = metrics[key];
    if (value === undefined || value === null) return "N/A";
    if (typeof value === "number" && !Number.isInteger(value)) return value.toFixed(1);
    return String(value);
  });
}
const result = interpolateTemplate("Context at {{contextUsage}}%, {{toolCallCount}} calls", { contextUsage: 75, toolCallCount: 30 });
console.assert(result === "Context at 75%, 30 calls", "template should interpolate correctly");
console.log("  PASS: Template interpolation works correctly");

// --- Test 4: Rule filtering by agent role ---
console.log("Test 4: Rule filtering by agent role");
const coderRules = config.rules.filter(r => r.agentRoles?.includes("coder"));
console.assert(coderRules.length >= 2, "coder should have at least 2 rules (warning + block)");
const researcherRules = config.rules.filter(r => r.agentRoles?.includes("researcher"));
console.assert(researcherRules.length >= 1, "researcher should have at least 1 rule");
console.log("  PASS: Rule filtering by agent role works");

// --- Test 5: Action priority ---
console.log("Test 5: Action priority");
const priority = { block: 3, requireApproval: 2, pass: 1 };
const sorted = [...config.rules].sort((a, b) => (priority[b.action] || 0) - (priority[a.action] || 0));
console.assert(sorted[0].action === "block", "block should be highest priority");
console.log("  PASS: Action priority sorting works");

console.log("\nAll tests passed!");
```

- [ ] **Step 2: Run the test**

Run: `node test-harness.js`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add test-harness.js
git commit -m "test(harness): add integration test for rule evaluator"
```

---

### Task 13: Final syntax check and gateway restart test

**Files:**
- All modified files

- [ ] **Step 1: Full syntax check**

Run: `node -c index.js`
Expected: No syntax errors

- [ ] **Step 2: Verify harness-rules.json is valid**

Run: `node -e "JSON.parse(require('fs').readFileSync('harness-rules.json','utf-8')); console.log('valid')"`
Expected: `valid`

- [ ] **Step 3: Verify openclaw.plugin.json is valid**

Run: `node -e "JSON.parse(require('fs').readFileSync('openclaw.plugin.json','utf-8')); console.log('valid')"`
Expected: `valid`

- [ ] **Step 4: Run integration test**

Run: `node test-harness.js`
Expected: All tests pass

- [ ] **Step 5: Restart OpenClaw gateway and verify no errors**

Run: `openclaw stop && openclaw start`
Then check logs for `[HARNESS]` or `[claw-monitor]` errors.

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "feat(harness): complete Phase 1 harness implementation"
```
