const { definePluginEntry } = require("openclaw/plugin-sdk/plugin-entry");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

// --- In-memory state ---
const subagentTracker = new Map();
const alertQueue = [];
const recentErrors = []; // { sessionKey, error, ts }
let mainSessionKey = null; // track main agent's session key
let apiRef = null; // reference to plugin API for push alerts
const agentHealthStats = new Map(); // agentId -> { runs: [{outcome, duration, cost, error}] }
const retryCounter = new Map(); // sessionKey -> retry count for auto-retry
let pendingRestartNotification = null; // deferred restart notification text, injected once mainSessionKey is captured

// --- Helpers ---
function resolveOpenclawDir() {
  return process.env.OPENCLAW_DIR || path.join(os.homedir(), ".openclaw");
}

// --- SessionKey-to-file mapping via sessions.json ---
// The hook's childSessionKey (e.g. "agent:researcher:subagent:uuid1") has a DIFFERENT UUID
// than the JSONL filename (e.g. "uuid2"). sessions.json maps between them:
//   key = "agent:researcher:subagent:uuid1", value.sessionId = "uuid2"
// We read sessions.json to resolve this mapping.

function resolveAgentIdFromSessionKey(sessionKey) {
  if (sessionKey.startsWith("agent:")) {
    const parts = sessionKey.split(":");
    return parts[1] || "unknown";
  }
  const parts = sessionKey.split(":");
  return parts[0] || "unknown";
}

// Resolve the actual sessionId (JSONL filename UUID) from a sessionKey
// by reading sessions.json. Falls back to last-segment extraction.
function resolveSessionIdFromSessionKey(sessionKey) {
  const agentId = resolveAgentIdFromSessionKey(sessionKey);
  const mapping = loadSessionsJson(agentId);
  if (mapping && mapping[sessionKey]?.sessionId) {
    return mapping[sessionKey].sessionId;
  }
  // Fallback: extract last segment (won't match JSONL file, but at least something)
  if (sessionKey.startsWith("agent:")) {
    const parts = sessionKey.split(":");
    return parts[parts.length - 1] || "";
  }
  const parts = sessionKey.split(":");
  return parts[1] || "";
}

// Load sessions.json for an agent, returning the key-value mapping
// Caches in memory for performance
const sessionsJsonCache = new Map(); // agentId -> { data, mtime }
function loadSessionsJson(agentId) {
  const openclawDir = resolveOpenclawDir();
  const filePath = path.join(openclawDir, "agents", agentId, "sessions", "sessions.json");
  try {
    const stat = fs.statSync(filePath);
    const cached = sessionsJsonCache.get(agentId);
    if (cached && cached.mtime === stat.mtimeMs) return cached.data;
    const content = fs.readFileSync(filePath, "utf-8");
    const data = JSON.parse(content);
    sessionsJsonCache.set(agentId, { data, mtime: stat.mtimeMs });
    return data;
  } catch {
    return null;
  }
}

// Get session metadata from sessions.json (status, endedAt, label, totalTokens, etc.)
function getSessionMetaFromSessionsJson(sessionKey) {
  const agentId = resolveAgentIdFromSessionKey(sessionKey);
  const mapping = loadSessionsJson(agentId);
  if (!mapping || !mapping[sessionKey]) return null;
  const entry = mapping[sessionKey];
  return {
    sessionId: entry.sessionId,
    status: entry.status,
    endedAt: entry.endedAt,
    startedAt: entry.startedAt,
    label: entry.label,
    totalTokens: entry.totalTokens,
    estimatedCostUsd: entry.estimatedCostUsd,
    runtimeMs: entry.runtimeMs,
    spawnedBy: entry.spawnedBy,
    sessionStartedAt: entry.sessionStartedAt,
    updatedAt: entry.updatedAt,
    lastInteractionAt: entry.lastInteractionAt,
    spawnDepth: entry.spawnDepth,
    subagentRole: entry.subagentRole,
  };
}

// Build the file-discovery sessionKey format ("researcher:sessionId")
// from the hook's sessionKey format ("agent:researcher:subagent:uuid1")
function toFileDiscoveryKey(sessionKey) {
  const agentId = resolveAgentIdFromSessionKey(sessionKey);
  const sessionId = resolveSessionIdFromSessionKey(sessionKey);
  return `${agentId}:${sessionId}`;
}

function findJsonlFile(agentId, sessionId) {
  const openclawDir = resolveOpenclawDir();
  const sessionsDir = path.join(openclawDir, "agents", agentId, "sessions");
  if (!fs.existsSync(sessionsDir)) return null;
  const exact = path.join(sessionsDir, `${sessionId}.jsonl`);
  if (fs.existsSync(exact)) return exact;
  try {
    const files = fs.readdirSync(sessionsDir);
    const match = files.find(f => f.startsWith(`${sessionId}.jsonl`));
    if (match) return path.join(sessionsDir, match);
  } catch {}
  return null;
}

function formatElapsed(ms) {
  if (ms == null || Number.isNaN(ms) || ms < 0) return "n/a";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}min`;
}

function getConfig(pluginConfig) {
  return {
    stuckThresholdMs: (pluginConfig?.stuckThresholdMinutes || 5) * 60000,
    requireIdleConfirmation: pluginConfig?.requireIdleConfirmation !== false,
    maxWatchLines: pluginConfig?.maxWatchLines || 200,
    costAlertThresholdUsd: pluginConfig?.costAlertThresholdUsd || 5,
    tokenAlertThreshold: pluginConfig?.tokenAlertThreshold || 100000,
    alertCheckIntervalMs: (pluginConfig?.alertCheckIntervalSeconds || 30) * 1000,
    checkpointRefreshIntervalMs: (pluginConfig?.checkpointRefreshIntervalSeconds || 15) * 1000,
    orphanGraceMs: (pluginConfig?.orphanGraceMinutes || 60) * 60000,
  };
}

function extractTextContent(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map(block => {
      if (!block) return "";
      if (typeof block === "string") return block;
      if (block.type === "text" && typeof block.text === "string") return block.text;
      if (typeof block.content === "string") return block.content;
      return "";
    })
    .filter(Boolean)
    .join(" ");
}

function isOpenClawInjectedUserMessage(text) {
  return text.includes("[Subagent Context]") ||
    text.includes("You are running as a subagent") ||
    text.startsWith("[Claw Monitor") ||
    text.startsWith("[CLAW-MONITOR") ||
    text.startsWith("[Pipeline") ||
    text.startsWith("[Checkpoint ");
}

function debugLog(message) {
  if (process.env.CLAW_MONITOR_DEBUG === "1") {
    console.error(`[claw-monitor] ${message}`);
  }
}

function normalizeTimestamp(value) {
  if (typeof value === "number" && value > 0) return value;
  if (typeof value === "string" && value) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

// Extract the first user prompt from a JSONL file for meaningful task descriptions
function extractTaskFromJsonl(filePath) {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter(l => l.trim());
    for (const line of lines.slice(0, 80)) {
      try {
        const evt = JSON.parse(line);
        if (evt.type === "message" && evt.message) {
          const msg = evt.message;
          if (msg.role === "user" && msg.content) {
            const text = extractTextContent(msg.content);
            if (text.trim()) {
              // Skip OpenClaw-injected subagent context messages
              if (isOpenClawInjectedUserMessage(text)) {
                continue;
              }
              return text.trim().slice(0, 200);
            }
          }
        }
      } catch {}
    }
    // Fallback: extract from first assistant message (often describes the task)
    for (const line of lines.slice(0, 80)) {
      try {
        const evt = JSON.parse(line);
        if (evt.type === "message" && evt.message) {
          const msg = evt.message;
          if (msg.role === "assistant" && msg.content) {
            const text = extractTextContent(msg.content);
            if (text.trim().length > 10) {
              return text.trim().slice(0, 200);
            }
          }
        }
      } catch {}
    }
  } catch {}
  return null;
}

// Parse JSONL transcript into events array
function parseJsonlEvents(filePath, maxLines) {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter(l => l.trim());
    const recent = lines.slice(-(maxLines || 200));
    const events = [];
    for (const line of recent) {
      try { events.push(JSON.parse(line)); } catch {}
    }
    return events;
  } catch {}
  return [];
}

function readRecentJsonlEvents(filePath, maxLines, maxBytes = 256 * 1024) {
  try {
    const stat = fs.statSync(filePath);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      const content = buffer.toString("utf-8");
      const lines = content.split("\n").filter(l => l.trim()).slice(-(maxLines || 80));
      const events = [];
      for (const line of lines) {
        try { events.push(JSON.parse(line)); } catch {}
      }
      return events;
    } finally {
      fs.closeSync(fd);
    }
  } catch {}
  return [];
}

// Read the FIRST maxLines from a JSONL file (for step-plan extraction).
// Step declarations appear early and throughout, not just at the end.
function readEarlyJsonlEvents(filePath, maxLines) {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter(l => l.trim()).slice(0, maxLines || 200);
    const events = [];
    for (const line of lines) {
      try { events.push(JSON.parse(line)); } catch {}
    }
    return events;
  } catch {}
  return [];
}

function findTrajectoryFile(jsonlPath) {
  const candidates = [
    `${jsonlPath}.trajectory`,
    `${jsonlPath}.trajectory.jsonl`,
    jsonlPath.replace(/\.jsonl$/, ".trajectory.jsonl"),
    jsonlPath.replace(/\.jsonl$/, ".trajectory"),
  ];
  return candidates.find(candidate => candidate && fs.existsSync(candidate)) || null;
}

function isModelGeneratingFromTrajectory(trajectoryEvents) {
  // The trajectory file records prompt.submitted when a model call starts
  // and model.completed when it finishes. If submitted > completed, the
  // model is actively generating a response.
  let submitted = 0;
  let completed = 0;
  for (const evt of trajectoryEvents) {
    if (evt?.type === "prompt.submitted") submitted++;
    else if (evt?.type === "model.completed") completed++;
  }
  return submitted > completed;
}

function isSessionProcessAlive(filePath) {
  // Check if the .lock file exists and the PID is still running
  try {
    const lockPath = `${filePath}.lock`;
    if (!fs.existsSync(lockPath)) return false;
    const lockData = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
    if (!lockData.pid) return false;
    // Signal 0 checks if process exists without killing it
    try {
      process.kill(lockData.pid, 0);
      return true;
    } catch {
      return false; // Process not running
    }
  } catch {
    return false;
  }
}

function getLastMeaningfulTranscriptEvent(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const evt = events[i];
    if (evt?.type !== "message" || !evt.message) continue;
    const msg = evt.message;
    if (msg.role === "assistant") {
      if (Array.isArray(msg.content) && msg.content.some(block => block?.type === "tool_use" || block?.type === "toolCall")) {
        return { type: "tool_call", event: evt };
      }
      return { type: "assistant_message", event: evt };
    }
    if (msg.role === "toolResult" || msg.role === "tool_result") return { type: "tool_result", event: evt };
    if (msg.role === "user") return { type: "user_message", event: evt };
  }
  return null;
}

function confirmIdleBeforeStuckAlert(sessionKey, entry, filePath, staleMs, config) {
  if (!config.requireIdleConfirmation) {
    return { shouldAlert: true, level: "critical", reason: "idle confirmation disabled" };
  }

  try {
    // 1. Check sessions.json for terminal status
    const meta = getSessionMetaFromSessionsJson(sessionKey);
    if (meta && isTerminalSessionStatus(meta.status, meta.endedAt)) {
      return { shouldAlert: false, level: "info", reason: `session already terminal (${meta.status || "ended"})` };
    }

    // 2. Check if sessions.json says "running" — strong signal
    const status = typeof meta?.status === "string" ? meta.status.toLowerCase() : "";
    const sessionStoreSaysRunning = status === "running";

    // 3. Check trajectory file for model generation state
    //    When prompt.submitted count > model.completed count, model is actively generating.
    //    This is the most reliable signal for "model is producing a long response".
    const trajectoryFile = findTrajectoryFile(filePath);
    const trajectoryEvents = trajectoryFile ? readRecentJsonlEvents(trajectoryFile, 200) : [];
    const modelIsGenerating = isModelGeneratingFromTrajectory(trajectoryEvents);

    // 4. Check if the session process is still alive (via .lock file PID)
    const processAlive = isSessionProcessAlive(filePath);

    // 5. Check last meaningful transcript event
    const transcriptEvents = readRecentJsonlEvents(filePath, 80);
    const lastEvent = getLastMeaningfulTranscriptEvent(transcriptEvents);

    // Decision logic:
    // - If model is actively generating (trajectory says so), suppress STUCK alert.
    //   This is the primary fix for false STUCK alerts during long model generation.
    if (modelIsGenerating) {
      return {
        shouldAlert: false,
        level: "warning",
        reason: `mtime stale for ${formatElapsed(staleMs)}, but trajectory shows model is actively generating (prompt.submitted > model.completed)`
      };
    }

    // - If the session process is alive and the last event is tool_result or user_message
    //   (i.e., waiting for assistant response), the model may be generating but the
    //   trajectory hasn't been updated yet. Suppress with lower confidence.
    const waitingForAssistant =
      lastEvent?.type === "tool_result" ||
      lastEvent?.type === "user_message";
    if (processAlive && waitingForAssistant) {
      return {
        shouldAlert: false,
        level: "warning",
        reason: `mtime stale for ${formatElapsed(staleMs)}, but process alive and waiting for assistant response`
      };
    }

    // - If sessions.json says "running" and process is alive, give benefit of doubt
    //   but with a time limit (2x threshold = definitely stuck)
    if (sessionStoreSaysRunning && processAlive && staleMs < config.stuckThresholdMs * 2) {
      return {
        shouldAlert: false,
        level: "warning",
        reason: `mtime stale for ${formatElapsed(staleMs)}, but session status=running and process alive (grace period)`
      };
    }

    // - If process is dead, this is a genuine stuck/orphan
    if (!processAlive) {
      return {
        shouldAlert: true,
        level: "critical",
        reason: `confirmed stuck; process dead, status=${status || "unknown"}, lastEvent=${lastEvent?.type || "unknown"}`
      };
    }

    return {
      shouldAlert: true,
      level: "critical",
      reason: `confirmed idle; status=${status || "unknown"}, lastEvent=${lastEvent?.type || "unknown"}, processAlive=${processAlive}`
    };
  } catch (err) {
    debugLog(`idle confirmation failed for ${sessionKey}: ${err instanceof Error ? err.message : String(err)}`);
    return { shouldAlert: true, level: "critical", reason: "idle confirmation failed" };
  }
}

function extractUserMessageStats(events) {
  const userMessages = [];
  for (const evt of events) {
    if (evt.type !== "message" || !evt.message || evt.message.role !== "user") continue;
    const text = extractTextContent(evt.message.content).trim();
    if (!text || isOpenClawInjectedUserMessage(text)) continue;
    userMessages.push({
      ts: evt.timestamp || "",
      text,
    });
  }
  const last = userMessages[userMessages.length - 1] || null;
  return {
    hasUserInput: userMessages.length > 0,
    userInputCount: userMessages.length,
    lastUserMessage: last ? last.text.slice(0, 200) : null,
    lastUserMessageAt: last ? last.ts : null,
  };
}

// Extract activity from events
function extractActivity(events, detail) {
  const activity = [];
  const toolCallCounts = {};
  let lastToolInput = null;
  let lastToolName = null;
  let retryCount = 0;
  let prevInput = null;
  const costByModel = {};
  let totalCost = 0;
  let totalTokens = 0;

  for (const evt of events) {
    if (evt.type === "message" && evt.message) {
      const msg = evt.message;
      const ts = evt.timestamp || "";

      if (msg.role === "user") {
        const text = extractTextContent(msg.content).trim();
        if (text && !isOpenClawInjectedUserMessage(text) && (detail === "full" || detail === "summary")) {
          activity.push({ ts, type: "user_message", text: text.slice(0, 500) });
        }
      }

      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "tool_use" || block.type === "toolCall") {
            const input = block.input || block.arguments || {};
            let inputStr;
            if (block.name === "exec" || block.name === "Exec") {
              inputStr = input.command || JSON.stringify(input);
            } else if (block.name === "Read" || block.name === "read") {
              inputStr = input.file_path || input.path || JSON.stringify(input);
            } else if (block.name === "Write" || block.name === "write") {
              inputStr = input.file_path || input.path || JSON.stringify(input);
            } else if (block.name === "Edit" || block.name === "edit") {
              inputStr = input.file_path || input.path || JSON.stringify(input);
            } else {
              inputStr = JSON.stringify(input).slice(0, 200);
            }

            toolCallCounts[block.name] = (toolCallCounts[block.name] || 0) + 1;

            if (prevInput && inputStr === prevInput && lastToolName === block.name) {
              retryCount++;
            }
            prevInput = inputStr;
            lastToolName = block.name;
            lastToolInput = { tool: block.name, input: inputStr };

            if (detail === "full" || detail === "summary") {
              activity.push({ ts, type: "tool_call", tool: block.name, input: inputStr });
            }
          }
        }
      }

      if (msg.role === "toolResult" || msg.role === "tool_result") {
        const text = typeof msg.content === "string" ? msg.content : "";
        const isError = msg.isError || false;
        if (detail === "full") {
          activity.push({ ts, type: "tool_result", tool: msg.toolName || "unknown", result: text.slice(0, 500), isError });
        } else if (detail === "summary") {
          activity.push({ ts, type: "tool_result", tool: msg.toolName || "unknown", result: isError ? "ERROR" : `(${text.length} chars)`, isError });
        }
      }

      if (msg.usage?.cost?.total) {
        const cost = msg.usage.cost.total;
        const tokens = msg.usage.totalTokens || 0;
        const model = msg.model || "unknown";
        totalCost += cost;
        totalTokens += tokens;
        if (!costByModel[model]) costByModel[model] = { cost: 0, tokens: 0 };
        costByModel[model].cost += cost;
        costByModel[model].tokens += tokens;
        if (detail === "full" || detail === "summary") {
          activity.push({ ts, type: "cost", costUsd: cost, tokens, model });
        }
      }
    }
  }

  return { activity, toolCallCounts, lastToolInput, lastToolName, retryCount, costByModel, totalCost, totalTokens };
}

// Generate digest summary with pattern recognition
function generateDigest(toolCallCounts, lastToolInput, lastToolName, retryCount, totalEvents) {
  const toolNames = Object.keys(toolCallCounts);
  if (toolNames.length === 0) {
    return `No tool calls detected in ${totalEvents} events.`;
  }

  const parts = [];

  // Pattern: downloading files
  const execCount = toolCallCounts["exec"] || toolCallCounts["Exec"] || 0;
  const readCount = toolCallCounts["Read"] || toolCallCounts["read"] || 0;
  const writeCount = toolCallCounts["Write"] || toolCallCounts["write"] || 0;
  const editCount = toolCallCounts["Edit"] || toolCallCounts["edit"] || 0;

  if (execCount > 3 && lastToolInput?.input?.includes("wget\|curl\|download\|fetch\|pip\|npm\|git clone")) {
    parts.push(`正在下载/安装资源，已执行${execCount}次命令`);
  } else if (writeCount > 3 && editCount === 0) {
    parts.push(`正在创建文件，已写入${writeCount}个文件`);
  } else if (editCount > 3 && writeCount === 0) {
    parts.push(`正在修改代码，已编辑${editCount}个文件`);
  } else if (readCount > 5 && execCount === 0 && writeCount === 0) {
    parts.push(`正在阅读代码/文档，已读取${readCount}个文件`);
  } else if (execCount > 0 && writeCount > 0) {
    parts.push(`正在执行命令(${execCount}次)并写入文件(${writeCount}个)`);
  } else if (execCount > 0) {
    parts.push(`正在执行命令(${execCount}次)`);
  } else {
    const callSummary = toolNames
      .sort((a, b) => toolCallCounts[b] - toolCallCounts[a])
      .map(t => `${toolCallCounts[t]} ${t}`)
      .join(", ");
    parts.push(`工具调用: ${callSummary}`);
  }

  // Pattern: retrying
  if (retryCount > 0) {
    if (retryCount >= 3) {
      parts.push(`卡在重试，同一操作已重试${retryCount}次`);
    } else {
      parts.push(`重试了${retryCount}次`);
    }
  }

  // Most recent action
  if (lastToolInput) {
    const inputPreview = lastToolInput.input.slice(0, 80);
    if (lastToolInput.tool === "exec" || lastToolInput.tool === "Exec") {
      parts.push(`最近: 执行 "${inputPreview}"`);
    } else if (lastToolInput.tool === "Read" || lastToolInput.tool === "read") {
      parts.push(`最近: 读取 ${inputPreview}`);
    } else if (lastToolInput.tool === "Write" || lastToolInput.tool === "write") {
      parts.push(`最近: 写入 ${inputPreview}`);
    } else if (lastToolInput.tool === "Edit" || lastToolInput.tool === "edit") {
      parts.push(`最近: 编辑 ${inputPreview}`);
    } else {
      parts.push(`最近: ${lastToolInput.tool} ${inputPreview}`);
    }
  }

  return parts.join("。") + "。";
}

// Push an alert and immediately try to inject it into main session
async function pushAlert(level, sessionKey, message) {
  const alert = {
    level,
    sessionKey,
    message,
    ts: Date.now(),
  };
  alertQueue.push(alert);
  if (alertQueue.length > 50) alertQueue.shift();

  // Proactively push to main agent's session (with JSONL fallback for v5.2)
  if (apiRef && mainSessionKey) {
    const alertText = `[CLAW-MONITOR ${level.toUpperCase()}] ${message}`;
    await injectIntoSession(apiRef, mainSessionKey, alertText, `alert-${sessionKey}-${alert.ts}`);
  }
}

// Inject text into a session's JSONL as a user message (fallback for enqueueNextTurnInjection on v5.2+)
function injectViaJsonl(sessionKey, text) {
  const agentId = resolveAgentIdFromSessionKey(sessionKey);
  const sessionId = resolveSessionIdFromSessionKey(sessionKey);
  const filePath = findJsonlFile(agentId, sessionId);
  if (!filePath) return false;
  try {
    const event = {
      type: "message",
      id: `claw-monitor-inject-${Date.now()}`,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: [{ type: "text", text }] },
    };
    fs.appendFileSync(filePath, JSON.stringify(event) + "\n");
    return true;
  } catch { return false; }
}

// Combined injection: try enqueueNextTurnInjection, fall back to JSONL append
async function injectIntoSession(api, sessionKey, text, idempotencyKey) {
  if (!sessionKey) {
    return "none";
  }
  let method = "none";
  try {
    await api.enqueueNextTurnInjection({
    sessionKey,
      text,
      placement: "prepend_context",
      idempotencyKey,
    });
    method = "enqueueNextTurnInjection";
  } catch {}
  // Always also write to JSONL as fallback (v5.2 regression: enqueueNextTurnInjection silently fails)
  if (injectViaJsonl(sessionKey, text)) {
    if (method !== "enqueueNextTurnInjection") method = "jsonl_append";
  }
  return method;
}

// Validate checkCommand for safety
function isCommandSafe(cmd) {
  if (!cmd || typeof cmd !== "string") return false;
  const dangerous = [">>", ">", "|&", "&&", ";", "$((", "rm -rf", "rm -r", "mkfs", "dd if=", ":(){", "fork", "chmod 777", "chown"];
  const lowerCmd = cmd.toLowerCase().trim();
  for (const d of dangerous) {
    if (lowerCmd.includes(d.toLowerCase())) return false;
  }
  if (/[;&`$]/.test(cmd)) return false;
  return true;
}

// --- Progress inference from JSONL transcript ---
// Infers completedSteps and remainingSteps by analyzing recent
// assistant messages, tool call sequences, and file operations.
// This runs every checkpoint refresh interval (default 60s), so it must be lightweight.

// Step keywords that indicate a phase transition in Chinese/English
const STEP_INDICATOR_PATTERNS = [
  // Chinese step markers
  /第[一二三四五六七八九十\d]+[步步骤]/,
  /步骤\s*\d/,
  /首先|然后|接着|接下来|最后|最终/,
  /已完成|完成[了了]?|已结束/,
  /正在|当前|现在/,
  /开始|启动|着手/,
  // English step markers
  /step\s*\d+/i,
  /first|second|third|next|then|finally|lastly/i,
  /phase\s*\d+/i,
  /completed|finished|done/i,
  /currently|now|in progress/i,
  /starting|beginning/i,
];

// File path patterns that hint at task phase
const FILE_PHASE_HINTS = [
  { pattern: /search|调研|research|survey/i, phase: "搜索调研" },
  { pattern: /draft|草稿|outline|大纲|初步/i, phase: "起草" },
  { pattern: /final|最终|完成|output|result|报告/i, phase: "生成最终产出" },
  { pattern: /test|测试|spec|验证/i, phase: "测试验证" },
  { pattern: /review|审查|检查|校验/i, phase: "审查校验" },
  { pattern: /summary|总结|摘要|synthesis/i, phase: "总结归纳" },
  { pattern: /translate|翻译/i, phase: "翻译" },
  { pattern: /format|格式化|排版/i, phase: "格式化排版" },
];

// Tool call to phase mapping
const TOOL_PHASE_MAP = {
  // Search/research phase
  web_search: "搜索",
  web_fetch: "获取网页内容",
  tavily_search: "搜索",
  tavily_extract: "提取网页内容",
  browser: "浏览器操作",
  // Reading/analysis phase
  Read: "阅读文件",
  read: "阅读文件",
  pdf: "阅读PDF",
  image: "分析图片",
  // Writing/creation phase
  Write: "写入文件",
  write: "写入文件",
  edit: "编辑文件",
  Edit: "编辑文件",
  image_generate: "生成图片",
  video_generate: "生成视频",
  music_generate: "生成音乐",
  tts: "生成语音",
  // Execution phase
  exec: "执行命令",
  Exec: "执行命令",
  process: "管理进程",
  // Communication
  message: "发送消息",
  sessions_send: "发送消息给其他agent",
  sessions_spawn: "派生子agent",
};

// Check if two step lists come from the same inference strategy (consistent style).
// Use intersection: if any step from existing appears in inferred, they're consistent.
function stepsAreConsistent(existing, inferred) {
  if (!existing?.length || !inferred?.length) return true;
  const existingPrefixes = existing.map(s => s.toLowerCase().replace(/["""\s]/g, "").slice(0, 8));
  const inferredPrefixes = inferred.map(s => s.toLowerCase().replace(/["""\s]/g, "").slice(0, 8));
  return existingPrefixes.some(ep => inferredPrefixes.some(ip => ep === ip || ep.includes(ip) || ip.includes(ep)));
}

function inferProgressFromJsonl(jsonlPath, taskDescription) {
  if (!jsonlPath || !fs.existsSync(jsonlPath)) {
    return { completedSteps: [], remainingSteps: [], lastToolCall: null };
  }

  // Strategy 1 needs early messages (step plans are declared throughout but start early),
  // Strategy 2 needs recent messages (tool calls happen in order).
  const earlyEvents = readEarlyJsonlEvents(jsonlPath, 200);
  const recentEvents = readRecentJsonlEvents(jsonlPath, 50, 128 * 1024);

  let lastToolCall = null;
  const toolPhaseOrder = [];
  const toolPhaseSeen = new Set();

  for (const evt of recentEvents) {
    if (evt.type !== "message" || !evt.message) continue;
    const msg = evt.message;
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "tool_use" || block.type === "toolCall") {
          const toolName = block.name || "unknown";
          lastToolCall = toolName;
          const phase = TOOL_PHASE_MAP[toolName];
          if (phase && !toolPhaseSeen.has(phase)) {
            toolPhaseSeen.add(phase);
            toolPhaseOrder.push(phase);
          }
        }
      }
    }
  }

  // Strategy 1: Extract explicit step mentions from EARLY assistant messages
  const assistantTexts = [];
  for (const evt of earlyEvents) {
    if (evt.type !== "message" || !evt.message) continue;
    const msg = evt.message;
    if (msg.role === "assistant") {
      const text = extractTextContent(msg.content).trim();
      if (text && text.length > 2) assistantTexts.push(text);
    }
  }

  // Phase A: Count total steps from "开始第X步" / "第X步完成" markers
  // This works even when steps have no inline description
  const stepCountRegex = /第([一二三四五六七八九十\d]+)步/g;
  const stepNumsSeen = new Set();
  for (const text of assistantTexts) {
    let m;
    while ((m = stepCountRegex.exec(text)) !== null) {
      stepNumsSeen.add(m[1]);
    }
  }
  const cnNumMap = {"一":"1","二":"2","三":"3","四":"4","五":"5","六":"6","七":"7","八":"8","九":"9","十":"10"};
  function normalizeStepNum(n) { return cnNumMap[n] || n; }
  const totalStepNums = [...stepNumsSeen].map(normalizeStepNum);

  // Phase B: Extract steps with descriptions from "第X步：描述" or "第X步 描述"
  const stepRegex = /(?:第([一二三四五六七八九十\d]+)[步步骤]|[Ss]tep\s*(\d+)|[Pp]hase\s*(\d+))\s*[:：]?\s*([^\n。；;]{2,80})/g;
  const foundSteps = [];
  const completionNoiseRe = /^(?:搜索|查询|分析)?\s*(?:已\s*)?完成|，接下来|，全部任务/;
  for (const text of assistantTexts) {
    let match;
    while ((match = stepRegex.exec(text)) !== null) {
      const stepNum = match[1] || match[2] || match[3];
      let stepDesc = match[4].trim();
      stepDesc = stepDesc.replace(/\*\*/g, "").replace(/✅\s*完成\s*\|?/g, "").replace(/⏳\s*进行中\s*\|?/g, "").replace(/\|\s*/g, " ").trim();
      stepDesc = stepDesc.replace(/^[：:]\s*/, "").replace(/\s*[—–-]\s*.+$/, "").trim();
      stepDesc = stepDesc.replace(/\s*(?:到|至)?\s*`[^`]*`.*$/, "").trim();
      if (!stepDesc || stepDesc.length < 2 || completionNoiseRe.test(stepDesc)) continue;
      foundSteps.push({ num: stepNum, desc: stepDesc });
    }
  }

  // Phase C: If we found step markers but no descriptions, try to map step numbers
  // to tool phases from the conversation. e.g. step 1 → web_search → "搜索"
  if (foundSteps.length < 2 && totalStepNums.length >= 2) {
    // Build a mapping of step number → tool phase from "开始第X步" context
    // Look for tool calls that appear between step markers
    const stepToolMap = new Map();
    let currentStep = null;
    for (const evt of earlyEvents) {
      if (evt.type !== "message" || !evt.message) continue;
      const msg = evt.message;
      // Track which step we're in from assistant text
      if (msg.role === "assistant") {
        const text = extractTextContent(msg.content).trim();
        const stepMarker = text.match(/第([一二三四五六七八九十\d]+)步/);
        if (stepMarker) {
          const num = normalizeStepNum(stepMarker[1]);
          if (!currentStep || currentStep !== num) {
            currentStep = num;
          }
        }
      }
      // Track tool calls within each step
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if ((block.type === "tool_use" || block.type === "toolCall") && currentStep) {
            const phase = TOOL_PHASE_MAP[block.name || "unknown"];
            if (phase && !stepToolMap.has(currentStep)) {
              stepToolMap.set(currentStep, phase);
            }
          }
        }
      }
    }
    // Deduplicate phase names by appending count suffix when same phase repeats
    const phaseCount = new Map();
    for (const num of totalStepNums.sort((a, b) => parseInt(a) - parseInt(b))) {
      const existing = foundSteps.find(s => normalizeStepNum(s.num) === num);
      if (!existing) {
        let desc = stepToolMap.get(num) || `步骤${num}`;
        const count = (phaseCount.get(desc) || 0) + 1;
        phaseCount.set(desc, count);
        if (count > 1) desc = desc + count;
        foundSteps.push({ num, desc });
      }
    }
  }

  // Detect which steps have explicit completion markers
  // Matches: "第X步完成", "第X步已完成", "第X步...已完成", "已完成第X步"
  const completedNums = new Set();
  const completionPatterns = [
    /第([一二三四五六七八九十\d]+)步\s*(?:已\s*)?完成/g,
    /已完成第([一二三四五六七八九十\d]+)步/g,
    /第([一二三四五六七八九十\d]+)步[^。\n]{0,20}已完成/g,
  ];
  for (const text of assistantTexts) {
    for (const regex of completionPatterns) {
      let match;
      while ((match = regex.exec(text)) !== null) {
        completedNums.add(match[1]);
      }
    }
  }

  // Deduplicate explicit steps by step number and description overlap
  const uniqueSteps = [];
  for (const s of foundSteps) {
    const normNum = normalizeStepNum(s.num);
    // Check if we already have a step with the same number
    const existingIdx = uniqueSteps.findIndex(u => u.num === normNum);
    if (existingIdx === -1) {
      uniqueSteps.push({ ...s, num: normNum });
    } else {
      // Same step number: keep the one with a more descriptive (longer, action-oriented) description
      const existing = uniqueSteps[existingIdx];
      const existingHasAction = /^(?:搜索|查询|分析|撰写|综合|执行|运行|编写|实现|测试|创建|生成|读取|写入|编辑|安装|部署)/.test(existing.desc);
      const newHasAction = /^(?:搜索|查询|分析|撰写|综合|执行|运行|编写|实现|测试|创建|生成|读取|写入|编辑|安装|部署)/.test(s.desc);
      // Prefer action-oriented descriptions; if both, prefer shorter (cleaner)
      if (newHasAction && !existingHasAction) {
        uniqueSteps[existingIdx] = { ...s, num: normNum };
      } else if (newHasAction && existingHasAction && s.desc.length < existing.desc.length) {
        uniqueSteps[existingIdx] = { ...s, num: normNum };
      }
    }
  }

  // If we found 2+ explicit steps, use them with completion tracking
  if (uniqueSteps.length >= 2) {
    const completedSteps = [];
    const remainingSteps = [];
    // Steps with explicit completion markers are definitely done
    for (const s of uniqueSteps) {
      if (completedNums.has(s.num)) {
        completedSteps.push(s.desc);
      } else {
        remainingSteps.push(s.desc);
      }
    }
    // The last step without a completion marker is the current step —
    // the subagent is actively working on it, so count it as completed progress
    if (remainingSteps.length === 1 && completedSteps.length > 0) {
      completedSteps.push(remainingSteps.pop());
    }
    // If no completion markers found, all but the very last step are completed
    if (completedSteps.length === 0 && uniqueSteps.length >= 2) {
      completedSteps.push(...uniqueSteps.slice(0, -1).map(s => s.desc));
      remainingSteps.length = 0;
      remainingSteps.push(uniqueSteps[uniqueSteps.length - 1].desc);
    }
    return { completedSteps, remainingSteps, lastToolCall };
  }

  // Strategy 2: Use ordered tool phases as completed steps
  if (toolPhaseOrder.length > 0) {
    const completedSteps = [...toolPhaseOrder];
    const remainingSteps = [];

    // Infer remaining from what's missing
    const hasSearch = toolPhaseSeen.has("搜索") || toolPhaseSeen.has("获取网页内容") || toolPhaseSeen.has("提取网页内容");
    const hasRead = toolPhaseSeen.has("阅读文件") || toolPhaseSeen.has("阅读PDF");
    const hasWrite = toolPhaseSeen.has("写入文件") || toolPhaseSeen.has("编辑文件");
    const hasExec = toolPhaseSeen.has("执行命令");
    const hasMedia = toolPhaseSeen.has("生成图片") || toolPhaseSeen.has("生成视频") || toolPhaseSeen.has("生成音乐") || toolPhaseSeen.has("生成语音");

    if (hasSearch && !hasWrite && !hasMedia) remainingSteps.push("撰写产出");
    if (hasRead && !hasWrite && !hasExec) remainingSteps.push("实现修改");
    if (hasWrite && !hasExec) remainingSteps.push("测试验证");
    if (hasMedia) remainingSteps.push("整合输出");

    return { completedSteps, remainingSteps, lastToolCall };
  }

  return { completedSteps: [], remainingSteps: [], lastToolCall };
}

function generateRunSummary(filePath, tracked) {
  const events = parseJsonlEvents(filePath, 500);
  const extracted = extractActivity(events, "summary");
  const userStats = extractUserMessageStats(events);
  const writtenFiles = [];
  const editedFiles = [];
  const readFiles = [];
  const keyCommands = [];

  for (const act of extracted.activity) {
    if (act.type !== "tool_call") continue;
    if ((act.tool === "Write" || act.tool === "write") && act.input) {
      if (!writtenFiles.includes(act.input)) writtenFiles.push(act.input);
    } else if ((act.tool === "Edit" || act.tool === "edit") && act.input) {
      if (!editedFiles.includes(act.input)) editedFiles.push(act.input);
    } else if ((act.tool === "Read" || act.tool === "read") && act.input) {
      if (!readFiles.includes(act.input)) readFiles.push(act.input);
    } else if ((act.tool === "exec" || act.tool === "Exec") && act.input) {
      if (keyCommands.length < 5) keyCommands.push(act.input);
    }
  }

  const hasErrors = events.some(e =>
    e.type === "message" && e.message?.role === "toolResult" && e.message?.isError
  );
  const elapsed = tracked.endedAt ? tracked.endedAt - tracked.startedAt : 0;
  const cost = extracted.totalCost || 0;

  const parts = [];
  if (writtenFiles.length > 0) {
    const names = writtenFiles.map(f => {
      const p = f.split("/"); return p[p.length - 1] || f;
    });
    parts.push(`写了${writtenFiles.length}个文件(${names.slice(0, 5).join(", ")}${names.length > 5 ? "..." : ""})`);
  }
  if (editedFiles.length > 0) {
    const names = editedFiles.map(f => {
      const p = f.split("/"); return p[p.length - 1] || f;
    });
    parts.push(`编辑了${editedFiles.length}个文件(${names.slice(0, 5).join(", ")}${names.length > 5 ? "..." : ""})`);
  }
  if (hasErrors) parts.push("有报错");
  if (elapsed > 0) parts.push(`耗时${formatElapsed(elapsed)}`);
  if (cost > 0) parts.push(`成本$${cost.toFixed(4)}`);

  return {
    summary: parts.join("，"),
    writtenFiles,
    editedFiles,
    readFiles: readFiles.slice(0, 10),
    keyCommands,
    hasErrors,
    elapsed,
    cost,
    tokens: extracted.totalTokens || 0,
    userStats,
  };
}

// Update health stats for an agentId
function updateAgentHealth(agentId, outcome, duration, cost, error) {
  if (!agentHealthStats.has(agentId)) {
    agentHealthStats.set(agentId, { runs: [] });
  }
  const stats = agentHealthStats.get(agentId);
  stats.runs.push({ outcome, duration, cost, error: error || null, ts: Date.now() });
  // Keep last 20 runs per agent
  if (stats.runs.length > 20) stats.runs.shift();
}

// Get health summary for an agentId
function getAgentHealth(agentId) {
  const stats = agentHealthStats.get(agentId);
  if (!stats || stats.runs.length === 0) return null;
  const recent = stats.runs.slice(-5);
  const successes = recent.filter(r => r.outcome === "success" || r.outcome === "completed").length;
  const avgDuration = recent.reduce((s, r) => s + (r.duration || 0), 0) / recent.length;
  const avgCost = recent.reduce((s, r) => s + (r.cost || 0), 0) / recent.length;
  const errors = recent.filter(r => r.error).map(r => r.error);
  const commonErrors = {};
  for (const e of errors) {
    const key = e.slice(0, 60);
    commonErrors[key] = (commonErrors[key] || 0) + 1;
  }
  const topError = Object.entries(commonErrors).sort((a, b) => b[1] - a[1])[0];

  return {
    recentRuns: recent.length,
    successRate: `${Math.round((successes / recent.length) * 100)}%`,
    avgDuration: formatElapsed(avgDuration),
    avgCost: `$${avgCost.toFixed(4)}`,
    commonFailure: topError ? topError[0] : null,
  };
}

// Check if an error is retryable
function isRetryableError(error) {
  if (!error) return false;
  const retryablePatterns = [
    /gateway.*(closed|disconnect|restart)/i,
    /engine.*busy/i,
    /timeout/i,
    /rate.?limit/i,
    /429/,
    /502|503|504/,
    /connection.*(reset|refused|closed)/i,
    /ECONNRESET/,
    /ECONNREFUSED/,
    /socket hang up/i,
    /api.*temporarily/i,
    /overloaded/i,
  ];
  return retryablePatterns.some(p => p.test(error));
}

// Snapshot files in a directory (for change tracking)
function snapshotDirectory(dirPath) {
  const snapshot = {};
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isFile()) {
        try {
          const stat = fs.statSync(fullPath);
          snapshot[fullPath] = { size: stat.size, mtime: stat.mtimeMs };
        } catch {}
      } else if (entry.isDirectory()) {
        Object.assign(snapshot, snapshotDirectory(fullPath));
      }
    }
  } catch {}
  return snapshot;
}

function createEmptyProgress() {
  return {
    writtenFiles: [],
    editedFiles: [],
    readFiles: [],
    keyCommands: [],
    lastToolCall: null,
    hasErrors: false,
    lastError: null,
    completedSteps: [],
    remainingSteps: []
  };
}

// Diff two directory snapshots
function diffSnapshots(before, after) {
  const created = [];
  const modified = [];
  const deleted = [];

  for (const [path, info] of Object.entries(after)) {
    if (!before[path]) {
      created.push(path);
    } else if (before[path].mtime !== info.mtime || before[path].size !== info.size) {
      modified.push(path);
    }
  }
  for (const path of Object.keys(before)) {
    if (!after[path]) {
      deleted.push(path);
    }
  }

  return { created, modified, deleted };
}

// Find recent session for same agentId (for cross-spawn context)
function findRecentSessionForAgent(agentId, excludeSessionKey) {
  const openclawDir = resolveOpenclawDir();
  const sessionsDir = path.join(openclawDir, "agents", agentId, "sessions");
  if (!fs.existsSync(sessionsDir)) return null;

  const tracked = subagentTracker.get(excludeSessionKey);
  const currentTask = tracked?.task || "";

  let bestMatch = null;
  let bestScore = 0;

  try {
    const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith(".jsonl") && !f.includes(".trajectory"));
    for (const file of files) {
      const sessionId = file.replace(/\.jsonl.*$/, "");
      const sessionKey = `${agentId}:${sessionId}`;
      if (sessionKey === excludeSessionKey) continue;

      const entry = subagentTracker.get(sessionKey);
      if (!entry || !entry.endedAt) continue;

      // Score by task similarity
      const task = entry.task || "";
      let score = 0;
      if (task && currentTask) {
        const words = currentTask.toLowerCase().split(/\s+/);
        for (const w of words) {
          if (w.length > 2 && task.toLowerCase().includes(w)) score++;
        }
      }
      // Prefer more recent sessions
      score += (entry.endedAt || 0) / 1e12;

      if (score > bestScore) {
        bestScore = score;
        bestMatch = entry;
      }
    }
  } catch {}

  return bestMatch;
}

// --- Checkpoint persistence ---
const CHECKPOINT_DIR = () => {
  const openclawDir = resolveOpenclawDir();
  return path.join(openclawDir, "checkpoints");
};

function checkpointPath(sessionKey) {
  const safeName = sessionKey.replace(/:/g, "_");
  return path.join(CHECKPOINT_DIR(), `${safeName}.json`);
}

function writeCheckpoint(sessionKey, data) {
  const dir = CHECKPOINT_DIR();
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    data.updatedAt = new Date().toISOString();
    const fp = checkpointPath(sessionKey);
    fs.writeFileSync(fp, JSON.stringify(data, null, 2));
    debugLog(`writeCheckpoint OK: ${fp}`);
  } catch (err) {
    console.error(`[claw-monitor] writeCheckpoint ERROR: ${err.message} sessionKey=${sessionKey}`);
  }
}

function readCheckpoint(sessionKey) {
  try {
    const fp = checkpointPath(sessionKey);
    if (!fs.existsSync(fp)) return null;
    const data = JSON.parse(fs.readFileSync(fp, "utf-8"));
    debugLog(`readCheckpoint OK: ${fp} outcome=${data.outcome}`);
    return data;
  } catch (err) {
    console.error(`[claw-monitor] readCheckpoint ERROR: ${err.message} sessionKey=${sessionKey}`);
    return null;
  }
}

function deleteCheckpoint(sessionKey) {
  try {
    const fp = checkpointPath(sessionKey);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  } catch {}
}

function findCheckpointByAgentId(agentId, excludeSessionKey) {
  const dir = CHECKPOINT_DIR();
  try {
    if (!fs.existsSync(dir)) return null;
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".json"));
    let best = null, bestTime = 0;
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8"));
        if (data.agentId === agentId && data.sessionKey !== excludeSessionKey) {
          const ts = new Date(data.updatedAt || data.createdAt).getTime();
          if (ts > bestTime) { best = data; bestTime = ts; }
        }
      } catch {}
    }
    return best;
  } catch { return null; }
}

function cleanOldCheckpoints(maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
  const dir = CHECKPOINT_DIR();
  try {
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".json"));
    const now = Date.now();
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8"));
        if (data.type === "final" && data.updatedAt) {
          if (now - new Date(data.updatedAt).getTime() > maxAgeMs) {
            fs.unlinkSync(path.join(dir, file));
          }
        }
      } catch {}
    }
  } catch {}
}

function hydrateEntryFromPersistentState(sessionKey, event = {}, ctx = {}) {
  const agentId = resolveAgentIdFromSessionKey(sessionKey);
  const meta = getSessionMetaFromSessionsJson(sessionKey);
  const cp = readCheckpoint(sessionKey);
  const sessionId = meta?.sessionId || resolveSessionIdFromSessionKey(sessionKey);
  const filePath = findJsonlFile(agentId, sessionId);
  let statStartedAt = null;
  try {
    statStartedAt = filePath ? fs.statSync(filePath).birthtimeMs : null;
  } catch {}

  const startedAt =
    normalizeTimestamp(meta?.startedAt) ||
    normalizeTimestamp(meta?.sessionStartedAt) ||
    normalizeTimestamp(cp?.createdAt) ||
    statStartedAt ||
    Date.now();
  const endedAt =
    normalizeTimestamp(event.endedAt) ||
    normalizeTimestamp(meta?.endedAt) ||
    Date.now();
  const task =
    cp?.task ||
    cp?.label ||
    meta?.label ||
    (filePath ? extractTaskFromJsonl(filePath) : "") ||
    "";

  return {
    childSessionKey: sessionKey,
    agentId: cp?.agentId || agentId,
    task,
    label: cp?.label || meta?.label || task,
    mode: "run",
    startedAt,
    endedAt,
    outcome: event.outcome || meta?.status || cp?.outcome || "ended",
    error: event.error || null,
    runId: ctx?.runId || "",
    parentSessionKey: cp?.parentSessionKey || meta?.spawnedBy || null,
    metadata: cp?.metadata || {},
    progress: cp?.progress || null,
    totalCostUsd: meta?.estimatedCostUsd || cp?.estimatedCostUsd || 0,
    totalTokens: meta?.totalTokens || cp?.totalTokens || 0,
    _stuckAlerted: false,
    _durationAlerted: false,
    _costAlerted: false,
    _tokenAlerted: false,
    _errorSpikeAlerted: false,
    _workingDir: process.cwd(),
    _dirSnapshot: null,
    runSummary: null,
    fileChanges: null,
  };
}

function updateIntermediateCheckpoint(key, entry, now = Date.now(), force = false) {
  if (!entry || entry.endedAt) return false;
  const meta = getSessionMetaFromSessionsJson(key);
  if (meta && isTerminalSessionStatus(meta.status, meta.endedAt)) {
    entry.endedAt =
      normalizeTimestamp(meta.endedAt) ||
      normalizeTimestamp(meta.updatedAt) ||
      now;
    entry.outcome = meta.status || entry.outcome || "ended";
    entry.error = entry.error || (meta.status === "failed" || meta.status === "timeout" ? meta.status : null);
    return false;
  }
  const existing = readCheckpoint(key);
  if (!force && existing?.updatedAt) {
    const lastUpdate = normalizeTimestamp(existing.updatedAt);
    if (lastUpdate && now - lastUpdate < 10000) return false;
  }

  const agentId = resolveAgentIdFromSessionKey(key);
  const sessionId = resolveSessionIdFromSessionKey(key);
  const jsonlPath = findJsonlFile(agentId, sessionId);
  const intermediateProgress = existing?.progress || createEmptyProgress();

  if (jsonlPath) {
    const summary = generateRunSummary(jsonlPath, entry);
    intermediateProgress.writtenFiles = summary.writtenFiles || intermediateProgress.writtenFiles;
    intermediateProgress.editedFiles = summary.editedFiles || intermediateProgress.editedFiles;
    intermediateProgress.readFiles = summary.readFiles || intermediateProgress.readFiles;
    intermediateProgress.keyCommands = summary.keyCommands || intermediateProgress.keyCommands;
    intermediateProgress.hasErrors = summary.hasErrors || false;
    intermediateProgress.lastError = entry.error || intermediateProgress.lastError || null;
    entry.totalCostUsd = summary.cost || entry.totalCostUsd || 0;
    entry.totalTokens = summary.tokens || entry.totalTokens || 0;
    entry.userStats = summary.userStats || entry.userStats || null;

    // Infer task progress steps from JSONL transcript
    // Always update — even if inferred steps are empty, the checkpoint still needs
    // its writtenFiles/readFiles/etc. fields written out
    const taskDesc = entry.task || entry.label || "";
    const inferred = inferProgressFromJsonl(jsonlPath, taskDesc);
    // If we already have steps from a previous refresh, only update if the new
    // inference is consistent (same strategy) — avoid strategy-switching duplicates
    const hasExistingSteps = (intermediateProgress.completedSteps?.length || 0) > 0;
    if (inferred.completedSteps.length > 0) {
      if (!hasExistingSteps || stepsAreConsistent(intermediateProgress.completedSteps, inferred.completedSteps)) {
        intermediateProgress.completedSteps = inferred.completedSteps;
      }
    }
    // Always update remainingSteps — when task completes, inferred.remainingSteps=[]
    // must overwrite the stale ["撰写产出"] from a previous tick
    intermediateProgress.remainingSteps = inferred.remainingSteps;
    if (inferred.lastToolCall) {
      intermediateProgress.lastToolCall = inferred.lastToolCall;
    }
  }

  const metadata = { ...(entry.metadata || {}) };
  if (entry.userStats?.hasUserInput) {
    metadata.hasUserInput = true;
    metadata.userInputCount = entry.userStats.userInputCount;
    metadata.lastUserMessage = entry.userStats.lastUserMessage;
    metadata.lastUserMessageAt = entry.userStats.lastUserMessageAt;
  }

  writeCheckpoint(key, {
    version: 1,
    sessionKey: key,
    agentId: entry.agentId,
    task: entry.task || entry.label || "",
    label: entry.label || "",
    parentSessionKey: entry.parentSessionKey,
    createdAt: existing?.createdAt || new Date(entry.startedAt || now).toISOString(),
    type: "intermediate",
    outcome: "running",
    progress: intermediateProgress,
    metadata
  });
  return true;
}

function normalizeOutcome(outcome) {
  const outcomeMap = {
    ok: "completed",
    done: "completed",
    success: "completed",
    completed: "completed",
    error: "failed",
    failed: "failed",
    timeout: "failed",
    killed: "killed",
    reset: "killed",
    deleted: "killed"
  };
  return outcomeMap[outcome] || outcome || "ended";
}

function isTerminalSessionStatus(status, endedAt) {
  if (endedAt) return true;
  return ["done", "completed", "failed", "timeout", "killed", "deleted", "error"].includes(status);
}

async function finalizeSubagentCheckpoint(key, entry, api, options = {}) {
  if (!entry) return null;
  const agentId = resolveAgentIdFromSessionKey(key);
  const sessionId = resolveSessionIdFromSessionKey(key);
  const filePath = findJsonlFile(agentId, sessionId);

  let runSummary = null;
  if (filePath) {
    runSummary = generateRunSummary(filePath, entry);
    entry.runSummary = runSummary;
  }

  let fileChanges = null;
  if (entry._dirSnapshot) {
    const afterSnapshot = snapshotDirectory(entry._workingDir || process.cwd());
    fileChanges = diffSnapshots(entry._dirSnapshot, afterSnapshot);
    entry.fileChanges = fileChanges;
  }

  const checkpoint = readCheckpoint(key) || {
    version: 1,
    sessionKey: key,
    agentId: entry.agentId,
    task: entry.task || entry.label || "",
    label: entry.label || "",
    parentSessionKey: entry.parentSessionKey,
    createdAt: new Date(entry.startedAt || Date.now()).toISOString(),
    type: "final",
    metadata: entry.metadata || {}
  };
  checkpoint.agentId = checkpoint.agentId || entry.agentId;
  checkpoint.task = checkpoint.task || entry.task || entry.label || "";
  checkpoint.label = checkpoint.label || entry.label || "";
  checkpoint.parentSessionKey = checkpoint.parentSessionKey || entry.parentSessionKey || null;
  checkpoint.outcome = normalizeOutcome(entry.outcome);
  checkpoint.type = "final";
  checkpoint.updatedAt = new Date().toISOString();
  const taskDesc = entry.task || entry.label || "";
  if (runSummary) {
    // For final checkpoint, prefer existing intermediate checkpoint steps (already deduped)
    // over re-running inference which may produce duplicates
    const existingProgress = checkpoint.progress || readCheckpoint(key)?.progress;
    const hasExistingSteps = (existingProgress?.completedSteps?.length || 0) > 0;

    let finalCompletedSteps;
    let finalRemainingSteps;
    let lastToolCall = null;

    if (hasExistingSteps) {
      // Re-run inference only for lastToolCall and remaining steps update
      const inferred = filePath ? inferProgressFromJsonl(filePath, taskDesc) : { completedSteps: [], remainingSteps: [], lastToolCall: null };
      lastToolCall = inferred.lastToolCall;
      const isSuccessful = normalizeOutcome(entry.outcome) === "completed";
      finalCompletedSteps = isSuccessful
        ? [...(existingProgress.completedSteps || []), ...(existingProgress.remainingSteps || [])]
        : [...(existingProgress.completedSteps || [])];
      finalRemainingSteps = isSuccessful ? [] : [...(existingProgress.remainingSteps || [])];
    } else {
      // No existing steps — fall back to fresh inference
      const inferred = filePath ? inferProgressFromJsonl(filePath, taskDesc) : { completedSteps: [], remainingSteps: [], lastToolCall: null };
      lastToolCall = inferred.lastToolCall;
      const isSuccessful = normalizeOutcome(entry.outcome) === "completed";
      finalCompletedSteps = isSuccessful
        ? [...(inferred.completedSteps || []), ...(inferred.remainingSteps || [])]
        : (inferred.completedSteps || []);
      finalRemainingSteps = isSuccessful ? [] : (inferred.remainingSteps || []);
    }

    checkpoint.progress = {
      writtenFiles: runSummary.writtenFiles || [],
      editedFiles: runSummary.editedFiles || [],
      readFiles: runSummary.readFiles || [],
      keyCommands: runSummary.keyCommands || [],
      lastToolCall: lastToolCall,
      hasErrors: runSummary.hasErrors || false,
      lastError: entry.error || null,
      completedSteps: finalCompletedSteps,
      remainingSteps: finalRemainingSteps
    };
    entry.userStats = runSummary.userStats || entry.userStats || null;
  }
  if (fileChanges) {
    checkpoint.progress = checkpoint.progress || createEmptyProgress();
    checkpoint.progress.writtenFiles = [...(checkpoint.progress.writtenFiles || []), ...fileChanges.created];
    checkpoint.progress.editedFiles = [...(checkpoint.progress.editedFiles || []), ...fileChanges.modified];
  }
  checkpoint.metadata = { ...(checkpoint.metadata || {}), ...(entry.metadata || {}) };
  if (entry.userStats?.hasUserInput) {
    checkpoint.metadata.hasUserInput = true;
    checkpoint.metadata.userInputCount = entry.userStats.userInputCount;
    checkpoint.metadata.lastUserMessage = entry.userStats.lastUserMessage;
    checkpoint.metadata.lastUserMessageAt = entry.userStats.lastUserMessageAt;
  }
  writeCheckpoint(key, checkpoint);

  if (options.injectSummary && mainSessionKey && api) {
    const summaryParts = [];
    summaryParts.push(`[Claw Monitor] 子agent "${entry.label || entry.agentId}" (${key}) 已结束: ${entry.outcome}`);
    if (runSummary) summaryParts.push(runSummary.summary);
    if (fileChanges) {
      if (fileChanges.created.length > 0) summaryParts.push(`新建文件: ${fileChanges.created.slice(0, 5).join(", ")}`);
      if (fileChanges.modified.length > 0) summaryParts.push(`修改文件: ${fileChanges.modified.slice(0, 5).join(", ")}`);
      if (fileChanges.deleted.length > 0) summaryParts.push(`删除文件: ${fileChanges.deleted.slice(0, 5).join(", ")}`);
    }
    if (entry.error) summaryParts.push(`错误: ${entry.error}`);
    const summaryText = summaryParts.join(". ") + ".";
    const method = await injectIntoSession(api, mainSessionKey, summaryText, `summary-${key}-${Date.now()}`);
    api.logger?.info?.(`[claw-monitor] finalized: injected summary into mainSessionKey=${mainSessionKey}, method=${method}`);
  }

  return { checkpoint, runSummary, fileChanges };
}

function discoverRunningSubagentsFromSessionsJson(config, logger) {
  const openclawDir = resolveOpenclawDir();
  const agentsDir = path.join(openclawDir, "agents");
  if (!fs.existsSync(agentsDir)) return 0;
  let discovered = 0;
  const now = Date.now();
  const graceMs = config?.orphanGraceMs || 60 * 60000;

  try {
    const agents = fs.readdirSync(agentsDir).filter(n => {
      if (n === "main") return false;
      return fs.existsSync(path.join(agentsDir, n, "sessions", "sessions.json"));
    });

    for (const agentId of agents) {
      const mapping = loadSessionsJson(agentId);
      if (!mapping) continue;
      for (const [key, val] of Object.entries(mapping)) {
        if (!key.startsWith("agent:") || subagentTracker.has(key)) continue;
        if (!key.includes(":subagent:") && !key.includes(":dashboard:") && !key.includes(":cron:")) continue;
        if (isTerminalSessionStatus(val.status, val.endedAt)) continue;
        const lastSeen =
          normalizeTimestamp(val.lastInteractionAt) ||
          normalizeTimestamp(val.updatedAt) ||
          normalizeTimestamp(val.startedAt) ||
          normalizeTimestamp(val.sessionStartedAt) ||
          0;
        if (!lastSeen || now - lastSeen > graceMs) {
          logger?.info?.(`[claw-monitor] skipped stale unended subagent: ${key}`);
          continue;
        }
        const entry = hydrateEntryFromPersistentState(key, {}, {});
        entry.endedAt = null;
        entry.outcome = null;
        subagentTracker.set(key, entry);
        discovered++;
        logger?.info?.(`[claw-monitor] recovered running subagent from sessions.json: ${key}`);
      }
    }
  } catch (err) {
    logger?.warn?.(`[claw-monitor] discover running subagents failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return discovered;
}

async function finalizeEndedSessionsFromSessionsJson(config, logger, api) {
  const openclawDir = resolveOpenclawDir();
  const agentsDir = path.join(openclawDir, "agents");
  if (!fs.existsSync(agentsDir)) return 0;
  let finalized = 0;

  try {
    const agents = fs.readdirSync(agentsDir).filter(n => {
      if (n === "main") return false;
      return fs.existsSync(path.join(agentsDir, n, "sessions", "sessions.json"));
    });

    for (const agentId of agents) {
      const mapping = loadSessionsJson(agentId);
      if (!mapping) continue;
      for (const [key, val] of Object.entries(mapping)) {
        if (!key.startsWith("agent:") || (!key.includes(":subagent:") && !key.includes(":dashboard:") && !key.includes(":cron:"))) continue;
        if (!isTerminalSessionStatus(val.status, val.endedAt)) continue;
        const cp = readCheckpoint(key);
        if (cp?.type === "final") continue;

        const entry = subagentTracker.get(key) || hydrateEntryFromPersistentState(key, {
          outcome: val.status || "ended",
          endedAt: val.endedAt || val.updatedAt || Date.now(),
          error: val.status === "failed" || val.status === "timeout" ? val.status : null
        }, {});
        entry.endedAt =
          normalizeTimestamp(val.endedAt) ||
          normalizeTimestamp(val.updatedAt) ||
          entry.endedAt ||
          Date.now();
        entry.outcome = val.status || entry.outcome || "ended";
        entry.error = entry.error || (val.status === "failed" || val.status === "timeout" ? val.status : null);
        subagentTracker.set(key, entry);

        await finalizeSubagentCheckpoint(key, entry, api, { injectSummary: false });
        finalized++;
        logger?.info?.(`[claw-monitor] finalized ended session from sessions.json: ${key} status=${val.status || "(endedAt)"}`);
      }
    }
  } catch (err) {
    logger?.warn?.(`[claw-monitor] finalize ended sessions failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return finalized;
}

function pruneStaleTrackedSubagents(config, logger) {
  const now = Date.now();
  const graceMs = config?.orphanGraceMs || 60 * 60000;
  let pruned = 0;

  for (const [key, entry] of subagentTracker.entries()) {
    if (entry.endedAt) continue;
    const meta = getSessionMetaFromSessionsJson(key);
    if (meta && isTerminalSessionStatus(meta.status, meta.endedAt)) continue;
    const lastSeen =
      normalizeTimestamp(meta?.lastInteractionAt) ||
      normalizeTimestamp(meta?.updatedAt) ||
      normalizeTimestamp(meta?.startedAt) ||
      normalizeTimestamp(meta?.sessionStartedAt) ||
      entry.startedAt ||
      0;
    if (lastSeen && now - lastSeen <= graceMs) continue;

    entry.endedAt = now;
    entry.outcome = "stale";
    entry.error = `stale unended session pruned after ${formatElapsed(now - (lastSeen || entry.startedAt || now))}`;
    pruned++;
    logger?.info?.(`[claw-monitor] pruned stale tracked subagent: ${key}`);
  }

  return pruned;
}

// --- Tool 1: subagent_status ---
function createSubagentStatusTool(config) {
  return {
    name: "subagent_status",
    label: "Subagent Status",
    description: "List all subagent runs with their current status, task description, progress, cost, and outcome. Use this to check what subagents are running or have completed.",
    parameters: {
      type: "object",
      properties: {
        filter: {
          type: "string",
          description: "Filter: 'active' for running only, 'ended' for completed only, omit for all",
          enum: ["active", "ended", "all"]
        },
        limit: {
          type: "number",
          description: "Max results to return (default 20)"
        }
      }
    },
    async execute(_id, params) {
      const filter = params.filter || "all";
      const limit = params.limit || 20;
      const now = Date.now();

      const openclawDir = resolveOpenclawDir();
      const agentsDir = path.join(openclawDir, "agents");
      const allRuns = [];

      for (const [key, entry] of subagentTracker.entries()) {
        const elapsed = entry.endedAt ? entry.endedAt - entry.startedAt : now - entry.startedAt;
        const isActive = !entry.endedAt;
        const metadata = entry.metadata || {};
        const progress = entry.progress || null;
        allRuns.push({
          childSessionKey: entry.childSessionKey,
          agentId: entry.agentId,
          task: entry.task || "(no task description)",
          label: entry.label || "",
          parentSessionKey: entry.parentSessionKey || null,
          status: isActive ? "running" : (entry.outcome || "ended"),
          startedAt: new Date(entry.startedAt).toISOString(),
          elapsed: formatElapsed(elapsed),
          endedAt: entry.endedAt ? new Date(entry.endedAt).toISOString() : null,
          error: entry.error || null,
          totalCostUsd: entry.totalCostUsd || null,
          totalTokens: entry.totalTokens || null,
          hasUserInput: entry.userStats?.hasUserInput || metadata.hasUserInput || false,
          userInputCount: entry.userStats?.userInputCount || metadata.userInputCount || 0,
          lastUserMessage: entry.userStats?.lastUserMessage || metadata.lastUserMessage || null,
          lastUserMessageAt: entry.userStats?.lastUserMessageAt || metadata.lastUserMessageAt || null,
          progress: progress,
          expectedDuration: metadata.expectedDuration || null,
          successCriteria: metadata.successCriteria || null,
          source: "hook"
        });
      }

      // --- File discovery via sessions.json (no duplicates) ---
      // Instead of scanning JSONL files directly (which creates duplicate entries with
      // different sessionKey formats), we read sessions.json which has the authoritative
      // mapping from "agent:researcher:subagent:uuid1" to sessionId (JSONL filename).
      if (fs.existsSync(agentsDir)) {
        try {
          const agents = fs.readdirSync(agentsDir).filter(n => {
            const sd = path.join(agentsDir, n, "sessions");
            return fs.existsSync(sd);
          });
          for (const agentId of agents) {
            if (agentId === "main") continue;
            const mapping = loadSessionsJson(agentId);
            if (!mapping) continue;
            for (const [key, val] of Object.entries(mapping)) {
              // Skip if already tracked by hook
              if (subagentTracker.has(key)) continue;
              // Only include subagent sessions (not direct webchat sessions)
              if (!key.startsWith("agent:")) continue;
              const sessionId = val.sessionId;
              if (!sessionId) continue;
              const filePath = findJsonlFile(agentId, sessionId);
              // Determine status from sessions.json (authoritative)
              const jsonlStatus = val.status; // "done", "failed", "timeout", or undefined for running
              const isActive = !val.endedAt && !jsonlStatus;
              const task = filePath ? (extractTaskFromJsonl(filePath) || val.label || "(discovered from sessions.json)") : (val.label || "(no transcript)");
              const userStats = filePath ? extractUserMessageStats(parseJsonlEvents(filePath, 500)) : null;
              allRuns.push({
                childSessionKey: key,
                agentId,
                task,
                label: val.label || "",
                parentSessionKey: val.spawnedBy || null,
                status: isActive ? "running" : (jsonlStatus || "ended"),
                startedAt: val.startedAt ? new Date(val.startedAt).toISOString() : (val.sessionStartedAt ? new Date(val.sessionStartedAt).toISOString() : null),
                elapsed: val.runtimeMs ? formatElapsed(val.runtimeMs) : (val.startedAt ? formatElapsed(now - val.startedAt) : "n/a"),
                endedAt: val.endedAt ? new Date(val.endedAt).toISOString() : null,
                error: jsonlStatus === "failed" ? "failed" : (jsonlStatus === "timeout" ? "timeout" : null),
                totalCostUsd: val.estimatedCostUsd || null,
                totalTokens: val.totalTokens || null,
                hasUserInput: userStats?.hasUserInput || false,
                userInputCount: userStats?.userInputCount || 0,
                lastUserMessage: userStats?.lastUserMessage || null,
                lastUserMessageAt: userStats?.lastUserMessageAt || null,
                progress: null,
                expectedDuration: null,
                successCriteria: null,
                source: "sessions.json"
              });
            }
          }
        } catch {}
      }

      let filtered = allRuns;
      if (filter === "active") filtered = allRuns.filter(r => r.status === "running");
      else if (filter === "ended") filtered = allRuns.filter(r => r.status !== "running");

      filtered.sort((a, b) => {
        if (a.status === "running" && b.status !== "running") return -1;
        if (a.status !== "running" && b.status === "running") return 1;
        return new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime();
      });

      const results = filtered.slice(0, limit);
      const summary = {
        total: allRuns.length,
        active: allRuns.filter(r => r.status === "running").length,
        ended: allRuns.filter(r => r.status !== "running").length,
        showing: results.length
      };

      // Add agentHealth for each unique agentId
      const healthByAgent = {};
      for (const run of results) {
        if (!healthByAgent[run.agentId]) {
          const health = getAgentHealth(run.agentId);
          if (health) healthByAgent[run.agentId] = health;
        }
      }

      return {
        content: [{ type: "text", text: JSON.stringify({ summary, agentHealth: healthByAgent, runs: results }, null, 2) }],
        details: { summary, agentHealth: healthByAgent, runs: results }
      };
    }
  };
}

// --- Tool 2: subagent_watch ---
function createSubagentWatchTool(config) {
  return {
    name: "subagent_watch",
    label: "Subagent Watch",
    description: "Read the recent transcript of a subagent. Use detail='digest' for a narrative summary, 'summary' for tool calls only, 'full' for tool calls + results.",
    parameters: {
      type: "object",
      properties: {
        sessionKey: {
          type: "string",
          description: "The childSessionKey of the subagent to watch (from subagent_status)"
        },
        lines: {
          type: "number",
          description: "Number of recent lines to read (default 50, max 200)"
        },
        detail: {
          type: "string",
          description: "Detail level: 'digest' for narrative summary, 'summary' for tool calls only, 'full' for tool calls + results",
          enum: ["digest", "summary", "full"]
        }
      },
      required: ["sessionKey"]
    },
    async execute(_id, params) {
      const sessionKey = params.sessionKey;
      const maxLines = Math.min(params.lines || 50, config.maxWatchLines);
      const detail = params.detail || "summary";

      const agentId = resolveAgentIdFromSessionKey(sessionKey);
      const sessionId = resolveSessionIdFromSessionKey(sessionKey);
      const filePath = findJsonlFile(agentId, sessionId);

      if (!filePath) {
        throw new Error(`Transcript file not found for sessionKey: ${sessionKey} (agentId=${agentId}, sessionId=${sessionId})`);
      }

      const stat = fs.statSync(filePath);
      const now = Date.now();
      const lastActivityMs = stat.mtimeMs;
      const staleMs = now - lastActivityMs;
      const isStuck = staleMs > config.stuckThresholdMs;
      const idleConfirmation = isStuck ? confirmIdleBeforeStuckAlert(sessionKey, null, filePath, staleMs, config) : null;
      const confirmedStuck = isStuck && (idleConfirmation?.shouldAlert !== false);

	      const events = parseJsonlEvents(filePath, maxLines);
	      const extracted = extractActivity(events, detail);
	      const userStats = extractUserMessageStats(events);
	
	      const result = {
        sessionKey,
        agentId,
        sessionId,
        lastActivity: new Date(lastActivityMs).toISOString(),
        staleFor: formatElapsed(staleMs),
        isStuck: confirmedStuck,
        isStuckRaw: isStuck,
        stuckSuppressedReason: idleConfirmation && !idleConfirmation.shouldAlert ? idleConfirmation.reason : null,
        stuckThreshold: `${config.stuckThresholdMs / 60000} minutes with no activity`,
	        totalEvents: events.length,
	        showingLines: events.length,
	        userMessages: userStats,
	      };

      if (detail === "digest") {
	        result.digest = generateDigest(
          extracted.toolCallCounts,
          extracted.lastToolInput,
          extracted.lastToolName,
          extracted.retryCount,
          events.length
	        );
	        if (userStats.hasUserInput) {
	          result.digest += ` 检测到${userStats.userInputCount}条用户消息，最后一条: "${userStats.lastUserMessage}"。`;
	        }
	      } else {
	        result.activity = extracted.activity;
	      }

      result.costSummary = {
        totalCostUsd: extracted.totalCost ? extracted.totalCost.toFixed(4) : null,
        totalTokens: extracted.totalTokens || null,
        byModel: extracted.costByModel,
      };

      // Update tracker with cost info
      const tracked = subagentTracker.get(sessionKey);
	      if (tracked) {
	        tracked.totalCostUsd = extracted.totalCost || 0;
	        tracked.totalTokens = extracted.totalTokens || 0;
	        tracked.userStats = userStats;
	      }

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result
      };
    }
  };
}

// --- Tool 3: subagent_kill ---
function createSubagentKillTool(api) {
  return {
    name: "subagent_kill",
    label: "Subagent Kill",
    description: "Terminate a stuck or unwanted subagent by its session key. Injects a termination instruction and falls back to JSONL append on v5.2 where enqueueNextTurnInjection may silently fail.",
    parameters: {
      type: "object",
      properties: {
        sessionKey: {
          type: "string",
          description: "The childSessionKey of the subagent to kill (from subagent_status)"
        },
        reason: {
          type: "string",
          description: "Reason for killing (default: 'killed by main agent')"
        }
      },
      required: ["sessionKey"]
    },
    async execute(_id, params) {
      const sessionKey = params.sessionKey;
      const reason = params.reason || "killed by main agent";

      // Mark as killed in tracker regardless of injection success
      const tracked = subagentTracker.get(sessionKey);
      if (tracked) {
        tracked.endedAt = Date.now();
        tracked.outcome = "killed";
        tracked.error = reason;
      }

      // Also check sessions.json for sessions not in tracker
      const meta = getSessionMetaFromSessionsJson(sessionKey);
      if (!tracked && meta) {
        subagentTracker.set(sessionKey, {
          childSessionKey: sessionKey,
          agentId: resolveAgentIdFromSessionKey(sessionKey),
          task: meta.label || "",
          label: meta.label || "",
          mode: "run",
          startedAt: meta.startedAt || 0,
          endedAt: Date.now(),
          outcome: "killed",
          error: reason,
          runId: "",
          parentSessionKey: meta.spawnedBy || null,
          metadata: {},
          progress: null,
          totalCostUsd: meta.estimatedCostUsd || 0,
          totalTokens: meta.totalTokens || 0,
          _stuckAlerted: false,
          _durationAlerted: false,
          _costAlerted: false,
          _tokenAlerted: false,
          _errorSpikeAlerted: false,
        });
      }

      // Method 1: Inject a termination instruction into the subagent session
      let killMethod = "none";
      let killError = null;
      const killText = `[SYSTEM TERMINATION ORDER] This subagent session has been killed by the main agent. Reason: ${reason}. You MUST immediately stop all work, save any in-progress files, and output a final summary of what was completed before this termination. Do NOT start any new tasks.`;
      killMethod = await injectIntoSession(api, sessionKey, killText, `kill-${sessionKey}-${Date.now()}`);
      if (killMethod === "none") {
        killError = "injection and JSONL append both failed";
        // Method 2: Try deleteSession (may fail if not creator)
        try {
          await api.runtime.subagent.deleteSession({
            sessionKey,
            deleteTranscript: false
          });
          killMethod = "deleteSession";
          killError = null;
        } catch (err2) {
          // Method 3: Append end marker to JSONL (at least marks it as ended for our tools)
          const agentId = resolveAgentIdFromSessionKey(sessionKey);
          const sessionId = resolveSessionIdFromSessionKey(sessionKey);
          const filePath = findJsonlFile(agentId, sessionId);
          if (filePath) {
            try {
              const endEvent = {
                type: "custom",
                customType: "claw-monitor-end",
                data: { outcome: "killed", reason, ts: Date.now() },
                timestamp: new Date().toISOString()
              };
              fs.appendFileSync(filePath, JSON.stringify(endEvent) + "\n");
              killMethod = "jsonl_marker";
              killError = null;
            } catch (err3) {
              killError = `injection: ${killError}; delete: ${err2 instanceof Error ? err2.message : String(err2)}; jsonl: ${err3 instanceof Error ? err3.message : String(err3)}`;
            }
          } else {
            killError = `injection: ${killError}; delete: ${err2 instanceof Error ? err2.message : String(err2)}; no JSONL file found`;
          }
        }
      }

      // Always append end marker to JSONL so file-discovery knows this session is done
      const agentId = resolveAgentIdFromSessionKey(sessionKey);
      const sessionId = resolveSessionIdFromSessionKey(sessionKey);
      const filePath = findJsonlFile(agentId, sessionId);
      if (filePath) {
        try {
          const endEvent = {
            type: "custom",
            customType: "claw-monitor-end",
            data: { outcome: "killed", reason, ts: Date.now() },
            timestamp: new Date().toISOString()
          };
          fs.appendFileSync(filePath, JSON.stringify(endEvent) + "\n");
        } catch {}
      }

      if (killError) {
        return {
          content: [{ type: "text", text: JSON.stringify({ status: "partial", sessionKey, reason, method: killMethod, warning: `Kill instruction delivery may have failed: ${killError}. Session marked as killed in tracker.`, trackerUpdated: true }, null, 2) }],
          details: { status: "partial", sessionKey, reason, method: killMethod, warning: killError }
        };
      }

      return {
        content: [{ type: "text", text: JSON.stringify({ status: "killed", sessionKey, reason, method: killMethod }, null, 2) }],
        details: { status: "killed", sessionKey, reason, method: killMethod }
      };
    }
  };
}

// --- Tool 4: subagent_progress ---
function createSubagentProgressTool(config) {
  return {
    name: "subagent_progress",
    label: "Subagent Progress",
    description: "Check progress of a subagent. If the subagent was spawned with metadata (successCriteria, expectedDuration, checkCommand), this tool auto-executes checkCommand and reports progress like '88/99 completed'.",
    parameters: {
      type: "object",
      properties: {
        sessionKey: {
          type: "string",
          description: "The childSessionKey of the subagent to check"
        }
      },
      required: ["sessionKey"]
    },
    async execute(_id, params) {
      const sessionKey = params.sessionKey;
      const tracked = subagentTracker.get(sessionKey);

      if (!tracked) {
        return {
          content: [{ type: "text", text: JSON.stringify({ status: "unknown", sessionKey, error: "Subagent not found in tracker" }, null, 2) }],
          details: { status: "unknown", sessionKey }
        };
      }

      const metadata = tracked.metadata || {};
      const now = Date.now();
      const elapsed = tracked.endedAt ? tracked.endedAt - tracked.startedAt : now - tracked.startedAt;
      const isActive = !tracked.endedAt;

      const result = {
        sessionKey,
        task: tracked.task || tracked.label || "",
        status: isActive ? "running" : (tracked.outcome || "ended"),
        elapsed: formatElapsed(elapsed),
        expectedDuration: metadata.expectedDuration ? formatElapsed(metadata.expectedDuration) : null,
        exceededExpectedDuration: metadata.expectedDuration ? elapsed > metadata.expectedDuration : false,
        successCriteria: metadata.successCriteria || null,
        progress: null,
      };

      // Execute checkCommand from metadata only (not from params, for security)
      const cmd = metadata.checkCommand;
      if (cmd && isActive && isCommandSafe(cmd)) {
        try {
          const output = execSync(cmd, { timeout: 10000, encoding: "utf-8" }).trim();
          result.progress = output;
          tracked.progress = output;
        } catch (err) {
          result.progress = `check failed: ${err.message}`;
        }
      } else if (cmd && !isCommandSafe(cmd)) {
        result.progress = "(checkCommand blocked: unsafe command)";
      } else if (tracked.progress) {
        result.progress = tracked.progress;
      }

      // Alert if exceeded expected duration
      if (result.exceededExpectedDuration && isActive) {
        pushAlert("warning", sessionKey,
          `Subagent "${tracked.label || tracked.agentId}" exceeded expected duration (${formatElapsed(elapsed)} > ${formatElapsed(metadata.expectedDuration)})`
        );
      }

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result
      };
    }
  };
}

// --- Tool 5: subagent_search ---
function createSubagentSearchTool() {
  return {
    name: "subagent_search",
    label: "Subagent Search",
    description: "Search historical and active subagent sessions by keyword. Matches against task descriptions, labels, agent IDs, and error messages.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search keyword or phrase"
        },
        limit: {
          type: "number",
          description: "Max results (default 10)"
        },
        filter: {
          type: "string",
          description: "Filter: 'active', 'ended', or 'all' (default 'all')",
          enum: ["active", "ended", "all"]
        }
      },
      required: ["query"]
    },
    async execute(_id, params) {
      const query = (params.query || "").toLowerCase();
      const limit = params.limit || 10;
      const filter = params.filter || "all";
      const now = Date.now();

      const openclawDir = resolveOpenclawDir();
      const agentsDir = path.join(openclawDir, "agents");
      const results = [];

      // Search tracked subagents
      for (const [key, entry] of subagentTracker.entries()) {
        const isActive = !entry.endedAt;
        if (filter === "active" && !isActive) continue;
        if (filter === "ended" && isActive) continue;

        const searchable = [
          entry.task || "",
          entry.label || "",
          entry.agentId || "",
          entry.error || "",
          entry.metadata?.successCriteria || "",
        ].join(" ").toLowerCase();

        if (searchable.includes(query)) {
          const elapsed = entry.endedAt ? entry.endedAt - entry.startedAt : now - entry.startedAt;
          results.push({
            childSessionKey: entry.childSessionKey,
            agentId: entry.agentId,
            task: entry.task || entry.label || "",
            parentSessionKey: entry.parentSessionKey || null,
            status: isActive ? "running" : (entry.outcome || "ended"),
            startedAt: new Date(entry.startedAt).toISOString(),
            elapsed: formatElapsed(elapsed),
            error: entry.error || null,
            source: "hook"
          });
        }
      }

      // Search sessions.json-discovered sessions (same source as subagent_status)
      if (fs.existsSync(agentsDir)) {
        try {
          const agents = fs.readdirSync(agentsDir).filter(n => {
            const sd = path.join(agentsDir, n, "sessions");
            return fs.existsSync(sd);
          });
          for (const agentId of agents) {
            if (agentId === "main") continue;
            const mapping = loadSessionsJson(agentId);
            if (!mapping) continue;
            for (const [key, val] of Object.entries(mapping)) {
              if (subagentTracker.has(key)) continue;
              if (!key.startsWith("agent:")) continue;
	              const sessionId = val.sessionId;
	              if (!sessionId) continue;
	              const filePath = findJsonlFile(agentId, sessionId);
	              const task = filePath ? (extractTaskFromJsonl(filePath) || val.label || "") : (val.label || "");
	              const userStats = filePath ? extractUserMessageStats(parseJsonlEvents(filePath, 500)) : null;
	              const searchable = `${task} ${agentId} ${key}`.toLowerCase();
              if (searchable.includes(query)) {
                const jsonlStatus = val.status;
                const isActive = !val.endedAt && !jsonlStatus;
                if (filter === "active" && !isActive) continue;
                if (filter === "ended" && isActive) continue;
                results.push({
                  childSessionKey: key,
                  agentId,
                  task: task || "(no description)",
                  parentSessionKey: val.spawnedBy || null,
                  status: isActive ? "running" : (jsonlStatus || "ended"),
	                  startedAt: val.startedAt ? new Date(val.startedAt).toISOString() : null,
	                  elapsed: val.runtimeMs ? formatElapsed(val.runtimeMs) : "n/a",
	                  error: jsonlStatus === "failed" ? "failed" : (jsonlStatus === "timeout" ? "timeout" : null),
	                  hasUserInput: userStats?.hasUserInput || false,
	                  userInputCount: userStats?.userInputCount || 0,
	                  lastUserMessage: userStats?.lastUserMessage || null,
	                  lastUserMessageAt: userStats?.lastUserMessageAt || null,
	                  source: "sessions.json"
	                });
              }
            }
          }
        } catch {}
      }

      results.sort((a, b) => {
        const aExact = a.task.toLowerCase().includes(query) ? 1 : 0;
        const bExact = b.task.toLowerCase().includes(query) ? 1 : 0;
        if (aExact !== bExact) return bExact - aExact;
        return new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime();
      });

      return {
        content: [{ type: "text", text: JSON.stringify({ query, total: results.length, results: results.slice(0, limit) }, null, 2) }],
        details: { query, total: results.length, results: results.slice(0, limit) }
      };
    }
  };
}

// --- Tool 6: subagent_steer ---
function createSubagentSteerTool(api) {
  return {
    name: "subagent_steer",
    label: "Subagent Steer",
    description: "Inject a steering message into an active subagent session to redirect it, instead of killing it. The message will be prepended to the subagent's next turn context.",
    parameters: {
      type: "object",
      properties: {
        sessionKey: {
          type: "string",
          description: "The childSessionKey of the subagent to steer (from subagent_status)"
        },
        message: {
          type: "string",
          description: "The steering instruction to inject (e.g. 'Stop downloading and switch to processing the files you already have')"
        }
      },
      required: ["sessionKey", "message"]
    },
    async execute(_id, params) {
      const sessionKey = params.sessionKey;
      const message = params.message;
      const tracked = subagentTracker.get(sessionKey);

      if (!tracked) {
        return {
          content: [{ type: "text", text: JSON.stringify({ status: "error", sessionKey, error: "Subagent not found in tracker" }, null, 2) }],
          details: { status: "error", sessionKey, error: "not found" }
        };
      }

      if (tracked.endedAt) {
        return {
          content: [{ type: "text", text: JSON.stringify({ status: "error", sessionKey, error: "Subagent has already ended" }, null, 2) }],
          details: { status: "error", sessionKey, error: "already ended" }
        };
      }

      const steerText = `[STEERING INSTRUCTION FROM MAIN AGENT] ${message}`;

      // Layer 1: Try injectIntoSession (enqueueNextTurnInjection + JSONL fallback)
      const method = await injectIntoSession(api, sessionKey, steerText, `steer-${sessionKey}-${Date.now()}`);
      if (method !== "none") {
        return {
          content: [{ type: "text", text: JSON.stringify({
            status: "steered",
            sessionKey,
            message,
            method,
            note: method === "jsonl_append" ? "Steering message appended directly to transcript (enqueueNextTurnInjection may not work on v5.2)." : undefined
          }, null, 2) }],
          details: { status: "steered", sessionKey, message, method }
        };
      }

      // Layer 2: Try runtime.subagent.run to send a message into the session
      try {
        const subResult = await api.runtime.subagent.run({
          sessionKey: sessionKey,
          message: steerText,
        });

        return {
            content: [{ type: "text", text: JSON.stringify({
              status: "steered",
              sessionKey,
              message,
              method: "subagent_run",
              subagentResult: subResult
            }, null, 2) }],
            details: { status: "steered", sessionKey, message, method: "subagent_run" }
          };
      } catch (err2) {
        const err2Msg = err2 instanceof Error ? err2.message : String(err2);
        return {
          content: [{ type: "text", text: JSON.stringify({
            status: "error",
            sessionKey,
            message,
            error: `All steering methods failed: ${err2Msg}`
          }, null, 2) }],
          details: { status: "error", sessionKey, error: err2Msg }
        };
      }
    }
  };
}

// --- Tool 7: subagent_on_alert ---
function createSubagentOnAlertTool() {
  return {
    name: "subagent_on_alert",
    label: "Subagent On Alert",
    description: "Query current pending alerts about subagents (stuck, timeout, error spike, cost overrun). Also returns a summary of all active subagents.",
    parameters: {
      type: "object",
      properties: {
        clear: {
          type: "boolean",
          description: "Clear the alert queue after reading (default: false)"
        }
      }
    },
    async execute(_id, params) {
      const clear = params.clear || false;
      const alerts = [...alertQueue];
      if (clear) alertQueue.length = 0;

      const activeSubagents = [];
      const now = Date.now();
      for (const [key, entry] of subagentTracker.entries()) {
        if (!entry.endedAt) {
          activeSubagents.push({
            childSessionKey: entry.childSessionKey,
            task: entry.task || entry.label || "",
            agentId: entry.agentId,
            parentSessionKey: entry.parentSessionKey || null,
            elapsed: formatElapsed(now - entry.startedAt),
            totalCostUsd: entry.totalCostUsd || 0,
            totalTokens: entry.totalTokens || 0,
          });
        }
      }

      const result = {
        pendingAlerts: alerts.length,
        alerts,
        activeSubagents: activeSubagents.length,
        activeSubagentSummary: activeSubagents,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result
      };
    }
  };
}

// --- Tool 8: subagent_pipeline ---
function createSubagentPipelineTool(api) {
  return {
    name: "subagent_pipeline",
    label: "Subagent Pipeline",
    description: "Define a simple pipeline of subagent tasks that run sequentially. When step A completes, step B is automatically spawned with A's output file paths injected into its task description. Use this to chain dependent tasks without manual handoff.",
    parameters: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          description: "Ordered list of pipeline steps. Each step has 'agent' (agentId) and 'task' (task description). Optionally 'outputFiles' (array of file paths that step produces for the next step).",
          items: {
            type: "object",
            properties: {
              agent: { type: "string", description: "Agent ID to spawn" },
              task: { type: "string", description: "Task description for this step" },
              outputFiles: {
                type: "array",
                description: "File paths this step is expected to produce (passed to next step)",
                items: { type: "string" }
              },
              metadata: {
                type: "object",
                description: "Optional metadata (verifyCommand, verifyExpected, verifyMessage, expectedDuration, etc.)"
              }
            },
            required: ["agent", "task"]
          }
        }
      },
      required: ["steps"]
    },
    async execute(_id, params) {
      const steps = params.steps;
      if (!steps || steps.length < 2) {
        return {
          content: [{ type: "text", text: JSON.stringify({ status: "error", error: "Pipeline needs at least 2 steps" }, null, 2) }],
          details: { status: "error" }
        };
      }

      const pipelineId = `pipeline-${Date.now()}`;
      const pipelineState = {
        id: pipelineId,
        steps: steps.map((s, i) => ({
          index: i,
          agent: s.agent,
          task: s.task,
          outputFiles: s.outputFiles || [],
          metadata: s.metadata || {},
          status: i === 0 ? "pending" : "waiting",
          sessionKey: null,
        })),
        currentStep: 0,
        status: "running",
        createdAt: Date.now(),
      };

      // Store pipeline state
      if (!globalThis.__clawMonitorPipelines) globalThis.__clawMonitorPipelines = new Map();
      globalThis.__clawMonitorPipelines.set(pipelineId, pipelineState);

      // Spawn first step
      const firstStep = pipelineState.steps[0];
      // Generate the childSessionKey ourselves (api.runtime.subagent.run doesn't return it)
      const firstStepKey = `agent:${firstStep.agent}:subagent:${crypto.randomUUID()}`;
      firstStep.sessionKey = firstStepKey;

      try {
        const spawnResult = await api.runtime.subagent.run({
          sessionKey: firstStepKey,
          message: firstStep.task,
          extraSystemPrompt: firstStep.metadata?.extraSystemPrompt || "",
        });

        firstStep.status = "running";
        const runId = spawnResult?.runId || "";

        // Manually add to tracker since subagent_spawned hook won't fire for api.runtime.subagent.run
        subagentTracker.set(firstStepKey, {
          childSessionKey: firstStepKey,
          agentId: firstStep.agent,
          task: firstStep.task,
          label: `pipeline-step-0: ${firstStep.task.slice(0, 60)}`,
          mode: "pipeline",
          startedAt: Date.now(),
          endedAt: null,
          outcome: null,
          error: null,
          runId,
          parentSessionKey: mainSessionKey,
          metadata: {
            ...(firstStep.metadata || {}),
            _pipelineId: pipelineId,
            _pipelineStep: 0,
          },
          progress: null,
          totalCostUsd: 0,
          totalTokens: 0,
          _stuckAlerted: false,
          _durationAlerted: false,
          _costAlerted: false,
          _tokenAlerted: false,
          _errorSpikeAlerted: false,
          _workingDir: process.cwd(),
          _dirSnapshot: null,
          runSummary: null,
          fileChanges: null,
        });

        api.logger.info(`[claw-monitor] Pipeline step 0 spawned: ${firstStepKey} agentId=${firstStep.agent} runId=${runId}`);
      } catch (err) {
        pipelineState.status = "failed";
        firstStep.status = "failed";
        return {
          content: [{ type: "text", text: JSON.stringify({ status: "error", pipelineId, error: `Failed to spawn first step: ${err instanceof Error ? err.message : String(err)}` }, null, 2) }],
          details: { status: "error", pipelineId }
        };
      }

      return {
        content: [{ type: "text", text: JSON.stringify({
          status: "started",
          pipelineId,
          totalSteps: steps.length,
          currentStep: 0,
          firstStepSessionKey: firstStepKey,
          message: `Pipeline started. Step 1/${steps.length} spawned. Subsequent steps will auto-start when previous step completes.`
        }, null, 2) }],
        details: { status: "started", pipelineId, totalSteps: steps.length }
      };
    }
  };
}

// Advance pipeline when a step's subagent ends
async function advancePipeline(endedSessionKey, api) {
  if (!globalThis.__clawMonitorPipelines) return;
  const tracked = subagentTracker.get(endedSessionKey);
  if (!tracked?.metadata?._pipelineId) return;

  const pipelineId = tracked.metadata._pipelineId;
  const stepIndex = tracked.metadata._pipelineStep;
  const pipeline = globalThis.__clawMonitorPipelines.get(pipelineId);
  if (!pipeline || pipeline.status !== "running") return;

  const currentStep = pipeline.steps[stepIndex];
  if (currentStep) {
    currentStep.status = tracked.outcome === "failed" ? "failed" : "completed";
  }

  // If current step failed, fail the pipeline
  if (tracked.outcome === "failed") {
    pipeline.status = "failed";
    await pushAlert("warning", endedSessionKey,
      `Pipeline ${pipelineId} FAILED at step ${stepIndex + 1}/${pipeline.steps.length}: ${tracked.error || "unknown error"}`
    );
    return;
  }

  // Advance to next step
  const nextStepIndex = stepIndex + 1;
  if (nextStepIndex >= pipeline.steps.length) {
    pipeline.status = "completed";
    if (mainSessionKey && api) {
      await injectIntoSession(api, mainSessionKey, `[Claw Monitor] Pipeline ${pipelineId} completed! All ${pipeline.steps.length} steps finished successfully.`, `pipeline-done-${pipelineId}`);
    }
    return;
  }

  // Build context from previous step's output
  const nextStep = pipeline.steps[nextStepIndex];
  let contextParts = [];
  if (currentStep.outputFiles && currentStep.outputFiles.length > 0) {
    contextParts.push(`上一步输出文件: ${currentStep.outputFiles.join(", ")}`);
  }
  if (tracked.runSummary) {
    if (tracked.runSummary.writtenFiles.length > 0) {
      contextParts.push(`上一步实际写入文件: ${tracked.runSummary.writtenFiles.join(", ")}`);
    }
  }
  const contextText = contextParts.length > 0
    ? `[Pipeline上下文] ${contextParts.join(". ")}.`
    : "";

  // Generate sessionKey ourselves (same format as subagent spawn)
  const nextStepKey = `agent:${nextStep.agent}:subagent:${crypto.randomUUID()}`;
  nextStep.sessionKey = nextStepKey;

  try {
    const spawnResult = await api.runtime.subagent.run({
      sessionKey: nextStepKey,
      message: nextStep.task,
      extraSystemPrompt: contextText,
    });

    nextStep.status = "running";
    pipeline.currentStep = nextStepIndex;
    const runId = spawnResult?.runId || "";

    // Manually add to tracker since subagent_spawned hook won't fire for api.runtime.subagent.run
    subagentTracker.set(nextStepKey, {
      childSessionKey: nextStepKey,
      agentId: nextStep.agent,
      task: nextStep.task,
      label: `pipeline-step-${nextStepIndex}: ${nextStep.task.slice(0, 60)}`,
      mode: "pipeline",
      startedAt: Date.now(),
      endedAt: null,
      outcome: null,
      error: null,
      runId,
      parentSessionKey: mainSessionKey,
      metadata: {
        ...(nextStep.metadata || {}),
        _pipelineId: pipelineId,
        _pipelineStep: nextStepIndex,
      },
      progress: null,
      totalCostUsd: 0,
      totalTokens: 0,
      _stuckAlerted: false,
      _durationAlerted: false,
      _costAlerted: false,
      _tokenAlerted: false,
      _errorSpikeAlerted: false,
      _workingDir: process.cwd(),
      _dirSnapshot: null,
      runSummary: null,
      fileChanges: null,
    });

    api.logger.info(`[claw-monitor] Pipeline step ${nextStepIndex} spawned: ${nextStepKey} agentId=${nextStep.agent}`);
  } catch (err) {
    nextStep.status = "failed";
    pipeline.status = "failed";
    await pushAlert("warning", endedSessionKey,
      `Pipeline ${pipelineId} FAILED to spawn step ${nextStepIndex + 1}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// --- Tool 8: subagent_checkpoint ---
function createSubagentCheckpointTool() {
  return {
    name: "subagent_checkpoint",
    label: "Subagent Checkpoint",
    description: "List, read, or delete checkpoints for subagent sessions. Use this to check what progress was saved before a crash, or to clean up old checkpoints.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "read", "delete"],
          description: "Action: list all checkpoints, read a specific one, or delete one"
        },
        sessionKey: {
          type: "string",
          description: "Session key of the checkpoint to read or delete (required for read/delete)"
        }
      },
      required: ["action"]
    },
    async execute(_id, params) {
      const dir = CHECKPOINT_DIR();

      if (params.action === "list") {
        try {
          if (!fs.existsSync(dir)) return { content: [{ type: "text", text: "No checkpoints found." }] };
          const files = fs.readdirSync(dir).filter(f => f.endsWith(".json"));
          const results = [];
          for (const file of files) {
            try {
              const data = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8"));
              results.push({
                sessionKey: data.sessionKey,
                agentId: data.agentId,
                label: data.label || (data.task || "").slice(0, 40),
                outcome: data.outcome,
                type: data.type,
                updatedAt: data.updatedAt,
                filesWritten: data.progress?.writtenFiles?.length || 0,
                filesEdited: data.progress?.editedFiles?.length || 0,
              });
            } catch {}
          }
          return {
            content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
            details: results
          };
        } catch (err) {
          return { content: [{ type: "text", text: `Error listing checkpoints: ${err.message}` }] };
        }
      }

      if (params.action === "read" && params.sessionKey) {
        const cp = readCheckpoint(params.sessionKey);
        if (!cp) return { content: [{ type: "text", text: `No checkpoint found for ${params.sessionKey}` }] };
        return { content: [{ type: "text", text: JSON.stringify(cp, null, 2) }], details: cp };
      }

      if (params.action === "delete" && params.sessionKey) {
        deleteCheckpoint(params.sessionKey);
        return { content: [{ type: "text", text: `Checkpoint deleted for ${params.sessionKey}` }] };
      }

      return { content: [{ type: "text", text: "Invalid action or missing sessionKey for read/delete" }] };
    }
  };
}

// --- Background alert checker service ---
function createAlertCheckerService(config, logger) {
  let intervalHandle = null;

  return {
    id: "claw-monitor-alert-checker",
    start(ctx) {
      logger.info("[claw-monitor] Alert checker starting");
      intervalHandle = setInterval(() => {
        try {
          logger.info("[claw-monitor] Alert checker tick");
          checkAlerts(config, logger);
        } catch (err) {
          logger.warn(`[claw-monitor] Alert checker error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }, config.alertCheckIntervalMs);
    },
    stop(ctx) {
      if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = null;
      }
      logger.info("[claw-monitor] Alert checker stopped");
    }
  };
}

async function discoverAbortedSubagentsAndNotifyMain(config, logger, api) {
  logger?.info?.(`[claw-monitor] discoverAbortedSubagentsAndNotifyMain called, mainSessionKey=${mainSessionKey}, api=${api ? 'present' : 'null'}`);
  const openclawDir = resolveOpenclawDir();
  const agentsDir = path.join(openclawDir, "agents");
  if (!fs.existsSync(agentsDir)) return;

  const abortedSubagents = [];
  try {
    const agents = fs.readdirSync(agentsDir).filter(n => {
      if (n === "main") return false;
      return fs.existsSync(path.join(agentsDir, n, "sessions", "sessions.json"));
    });

    for (const agentId of agents) {
      const mapping = loadSessionsJson(agentId);
      if (!mapping) continue;
      for (const [key, val] of Object.entries(mapping)) {
        if (!key.includes(":subagent:") && !key.includes(":dashboard:") && !key.includes(":cron:")) continue;
        if (val.abortedLastRun === true || val.status === "failed" || val.status === "timeout") {
          const cp = readCheckpoint(key);
          const taskDesc = cp?.task || cp?.label || val.label || "未知任务";
          const agent = cp?.agentId || resolveAgentIdFromSessionKey(key) || agentId;
          const completedSteps = cp?.progress?.completedSteps || [];
          const remainingSteps = cp?.progress?.remainingSteps || [];
          const writtenFiles = cp?.progress?.writtenFiles || [];
          abortedSubagents.push({ key, agent, task: taskDesc, completedSteps, remainingSteps, writtenFiles });
        }
      }
    }
  } catch (err) {
    logger?.warn?.(`[claw-monitor] discover aborted subagents failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Resolve mainSessionKey if not yet set (startup time)
  // Main sessions are long-lived channel sessions — their status is typically "done" or null, NOT "running".
  // We match any non-subagent/cron/acp entry regardless of status.
  if (!mainSessionKey) {
    const mainSessionsPath = path.join(openclawDir, "agents", "main", "sessions", "sessions.json");
    if (fs.existsSync(mainSessionsPath)) {
      try {
        const mainStore = JSON.parse(fs.readFileSync(mainSessionsPath, "utf-8"));
        // Sort by lastInteractionAt descending so we pick the most recently active main session
        const candidates = Object.entries(mainStore)
          .filter(([key]) => !key.includes("subagent") && !key.includes("cron") && !key.includes("acp"))
          .sort((a, b) => {
            const bTime = normalizeTimestamp(b[1].lastInteractionAt) || normalizeTimestamp(b[1].updatedAt) || 0;
            const aTime = normalizeTimestamp(a[1].lastInteractionAt) || normalizeTimestamp(a[1].updatedAt) || 0;
            return bTime - aTime;
          });
        if (candidates.length > 0) {
          mainSessionKey = candidates[0][0];
          logger?.info?.(`[claw-monitor] startup: resolved mainSessionKey=${mainSessionKey} from sessions.json (status=${candidates[0][1].status})`);
        } else {
          logger?.warn?.(`[claw-monitor] startup: no main session candidates found in sessions.json`);
        }
      } catch (err) {
        logger?.warn?.(`[claw-monitor] startup: failed to read main sessions.json: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      logger?.warn?.(`[claw-monitor] startup: main sessions.json not found at ${mainSessionsPath}`);
    }
  }

  if (abortedSubagents.length > 0) {
    const parts = ["[Claw Monitor 网关重启通知] 网关刚刚重启了，以下子agent的任务被中断，请检查checkpoint并决定是否重新派发："];
    for (const s of abortedSubagents) {
      let info = `- ${s.agent}: "${s.task}" (${s.key})`;
      if (s.completedSteps.length > 0) info += ` | 已完成: ${s.completedSteps.join(", ")}`;
      if (s.remainingSteps.length > 0) info += ` | 剩余: ${s.remainingSteps.join(", ")}`;
      if (s.writtenFiles.length > 0) info += ` | 已产出文件: ${s.writtenFiles.join(", ")}`;
      parts.push(info);
    }
    parts.push("请用 subagent_checkpoint action=read 读取具体checkpoint，然后决定是否重新spawn。");
    const notifyText = parts.join("\n");

    if (mainSessionKey && api) {
      // 1. Write to JSONL directly (ensures message is in transcript)
      const jsonlOk = injectViaJsonl(mainSessionKey, notifyText);
      logger?.info?.(`[claw-monitor] restart notify: injectViaJsonl=${jsonlOk} for mainSessionKey=${mainSessionKey}`);
      // 2. Also try enqueueNextTurnInjection as backup
      try {
        await api.enqueueNextTurnInjection({
          sessionKey: mainSessionKey,
          text: notifyText,
          placement: "prepend_context",
          idempotencyKey: `restart-notify-${Date.now()}`,
        });
        logger?.info?.(`[claw-monitor] restart notify: enqueueNextTurnInjection succeeded`);
      } catch (err) {
        logger?.warn?.(`[claw-monitor] restart notify: enqueueNextTurnInjection failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      // 3. Trigger heartbeat to wake up main session
      try {
        if (apiRef?.runtime?.system?.requestHeartbeat) {
          apiRef.runtime.system.requestHeartbeat({ source: "claw-monitor", intent: "restart-recovery", reason: `${abortedSubagents.length} aborted subagent(s) found on startup`, sessionKey: mainSessionKey });
          logger?.info?.(`[claw-monitor] restart notify: requested heartbeat to wake main session`);
        } else {
          logger?.warn?.(`[claw-monitor] restart notify: requestHeartbeat not available`);
        }
      } catch (err) {
        logger?.warn?.(`[claw-monitor] restart notify: heartbeat failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      // 4. Also enqueue system event as another wake-up path
      try {
        if (apiRef?.runtime?.system?.enqueueSystemEvent) {
          apiRef.runtime.system.enqueueSystemEvent(notifyText, { sessionKey: mainSessionKey });
          logger?.info?.(`[claw-monitor] restart notify: enqueued system event for mainSessionKey=${mainSessionKey}`);
        }
      } catch (err) {
        logger?.warn?.(`[claw-monitor] restart notify: enqueueSystemEvent failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      // mainSessionKey not yet available — defer injection until before_prompt_build captures it
      pendingRestartNotification = notifyText;
      logger?.info?.(`[claw-monitor] restart notify: mainSessionKey not yet available, deferred to before_prompt_build (aborted=${abortedSubagents.length})`);
    }
  }

  return abortedSubagents.length;
}

function createCheckpointRefreshService(config, logger) {
  let intervalHandle = null;

  return {
    id: "claw-monitor-checkpoint-refresh",
    start(ctx) {
      logger.info("[claw-monitor] Checkpoint refresh starting");
      discoverRunningSubagentsFromSessionsJson(config, logger);
      finalizeEndedSessionsFromSessionsJson(config, logger, apiRef).catch(err => {
        logger.warn(`[claw-monitor] Initial finalize ended sessions error: ${err instanceof Error ? err.message : String(err)}`);
      });
      pruneStaleTrackedSubagents(config, logger);
      // Gateway restart notification: check for aborted subagents and notify main session
      discoverAbortedSubagentsAndNotifyMain(config, logger, apiRef).then(abortedCount => {
        if (abortedCount > 0) {
          logger.info(`[claw-monitor] Found ${abortedCount} aborted subagent(s) on startup, notified main session`);
        }
      }).catch(err => {
        logger.warn(`[claw-monitor] startup abort notification error: ${err instanceof Error ? err.message : String(err)}`);
      });
      intervalHandle = setInterval(async () => {
        try {
          const now = Date.now();
          logger.info(`[claw-monitor] Checkpoint refresh tick (tracked=${subagentTracker.size}, now=${now})`);
          discoverRunningSubagentsFromSessionsJson(config, logger);
          await finalizeEndedSessionsFromSessionsJson(config, logger, apiRef);
          pruneStaleTrackedSubagents(config, logger);
          for (const [key, entry] of subagentTracker.entries()) {
            updateIntermediateCheckpoint(key, entry, now);
          }
          cleanOldCheckpoints();
        } catch (err) {
          logger.warn(`[claw-monitor] Checkpoint refresh error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }, config.checkpointRefreshIntervalMs);
    },
    stop(ctx) {
      if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = null;
      }
      logger.info("[claw-monitor] Checkpoint refresh stopped");
    }
  };
}

async function checkAlerts(config, logger) {
  const now = Date.now();

  for (const [key, entry] of subagentTracker.entries()) {
    if (entry.endedAt) continue;

    const elapsed = now - entry.startedAt;

    // Check stuck (no activity)
    const filePath = findJsonlFile(entry.agentId, resolveSessionIdFromSessionKey(key));
    if (filePath) {
      try {
        const stat = fs.statSync(filePath);
        const staleMs = now - stat.mtimeMs;
        if (staleMs > config.stuckThresholdMs && !entry._stuckAlerted) {
          const idleConfirmation = confirmIdleBeforeStuckAlert(key, entry, filePath, staleMs, config);
          if (idleConfirmation.shouldAlert) {
            await pushAlert(idleConfirmation.level, key,
              `Subagent "${entry.label || entry.agentId}" (${key}) appears STUCK — no activity for ${formatElapsed(staleMs)}. Last tool: check with subagent_watch. Consider subagent_kill or subagent_steer.`
            );
            entry._stuckAlerted = true;
            logger.info(`[claw-monitor] Stuck alert pushed: ${key} (${idleConfirmation.reason})`);
          } else {
            entry._stuckAlerted = false;
            entry._lastStuckSuppressedAt = now;
            logger.info(`[claw-monitor] Stuck alert suppressed: ${key} (${idleConfirmation.reason})`);
          }
        }
        if (staleMs <= config.stuckThresholdMs) {
          entry._stuckAlerted = false;
        }
      } catch {}
    }

    // Check expected duration exceeded
    const metadata = entry.metadata || {};
    if (metadata.expectedDuration && elapsed > metadata.expectedDuration && !entry._durationAlerted) {
      await pushAlert("warning", key,
        `Subagent "${entry.label || entry.agentId}" (${key}) exceeded expected duration (${formatElapsed(elapsed)} > ${formatElapsed(metadata.expectedDuration)})`
      );
      entry._durationAlerted = true;
    }

    // Check cost threshold
    if (entry.totalCostUsd && entry.totalCostUsd > config.costAlertThresholdUsd && !entry._costAlerted) {
      await pushAlert("warning", key,
        `Subagent "${entry.label || entry.agentId}" (${key}) cost $${entry.totalCostUsd.toFixed(4)} exceeds threshold $${config.costAlertThresholdUsd}`
      );
      entry._costAlerted = true;
    }

    // Check token threshold
    if (entry.totalTokens && entry.totalTokens > config.tokenAlertThreshold && !entry._tokenAlerted) {
      await pushAlert("warning", key,
        `Subagent "${entry.label || entry.agentId}" (${key}) used ${entry.totalTokens} tokens, exceeds threshold ${config.tokenAlertThreshold}`
      );
      entry._tokenAlerted = true;
    }
  }

  // Check error spikes (3+ errors in last 5 minutes)
  const recentWindow = now - 300000;
  const recentErrorEvents = recentErrors.filter(e => e.ts > recentWindow);
  const errorsByKey = {};
  for (const e of recentErrorEvents) {
    errorsByKey[e.sessionKey] = (errorsByKey[e.sessionKey] || 0) + 1;
  }
  for (const [sk, count] of Object.entries(errorsByKey)) {
    if (count >= 3) {
      const tracked = subagentTracker.get(sk);
      if (tracked && !tracked.endedAt && !tracked._errorSpikeAlerted) {
        await pushAlert("warning", sk,
          `Subagent "${tracked.label || tracked.agentId}" (${sk}) has ${count} errors in the last 5 minutes`
        );
        tracked._errorSpikeAlerted = true;
      }
    }
  }
}

// --- Plugin entry ---
module.exports = definePluginEntry({
  id: "claw-monitor",
  name: "Claw Monitor",
  description: "Gives the main agent real-time visibility into subagent execution: status, transcript watching, kill control, proactive alerts, progress tracking, and steering.",
  register(api) {
    const config = getConfig(api.pluginConfig);
    apiRef = api;

    api.registerTool(createSubagentStatusTool(config), { optional: true });
    api.registerTool(createSubagentWatchTool(config), { optional: true });
    api.registerTool(createSubagentKillTool(api), { optional: true });
    api.registerTool(createSubagentProgressTool(config), { optional: true });
    api.registerTool(createSubagentSearchTool(), { optional: true });
    api.registerTool(createSubagentSteerTool(api), { optional: true });
    api.registerTool(createSubagentOnAlertTool(), { optional: true });
    api.registerTool(createSubagentPipelineTool(api), { optional: true });
    api.registerTool(createSubagentCheckpointTool(), { optional: true });

	    // Register background alert checker service
	    api.registerService(createAlertCheckerService(config, api.logger));
	    api.registerService(createCheckpointRefreshService(config, api.logger));

    // Hook: subagent_spawned — track new subagents (fires after spawn succeeds)
    // NOTE: subagent_spawning only fires when threadBinding is requested, but
    // subagent_spawned always fires after a successful spawn.
    api.on("subagent_spawned", async (event, ctx) => {
      const parentKey = ctx?.requesterSessionKey || ctx?.sessionKey || null;
      const childKey = event.childSessionKey;
      const entry = {
        childSessionKey: childKey,
        agentId: event.agentId || resolveAgentIdFromSessionKey(childKey),
        task: event.label || "",
        label: event.label || "",
        mode: event.mode || "run",
        startedAt: Date.now(),
        endedAt: null,
        outcome: null,
        error: null,
        runId: event.runId || ctx?.runId || "",
        parentSessionKey: parentKey,
        metadata: {},
        progress: null,
        totalCostUsd: 0,
        totalTokens: 0,
        _stuckAlerted: false,
        _durationAlerted: false,
        _costAlerted: false,
        _tokenAlerted: false,
        _errorSpikeAlerted: false,
        _workingDir: process.cwd(),
        _dirSnapshot: null,
        runSummary: null,
        fileChanges: null,
      };

      // Extract metadata from spawn context if available
      if (event.metadata && typeof event.metadata === "object") {
        entry.metadata = event.metadata;
      }

      // Snapshot working directory for change tracking
      try {
        entry._dirSnapshot = snapshotDirectory(process.cwd());
      } catch {}

      subagentTracker.set(childKey, entry);
      api.logger.info(`[claw-monitor] subagent_spawned: ${childKey} agentId=${entry.agentId} label=${event.label || "(none)"} parent=${parentKey}`);

      // Capture mainSessionKey from parent (earlier than before_prompt_build)
      if (parentKey && !parentKey.includes("subagent") && !mainSessionKey) {
        mainSessionKey = parentKey;
        api.logger.info(`[claw-monitor] subagent_spawning: set mainSessionKey=${mainSessionKey} from parent`);
      }

      // --- Cross-spawn context injection ---
      const recentSession = findRecentSessionForAgent(entry.agentId, childKey);
      if (recentSession && recentSession.runSummary) {
        const ctxParts = [];
        if (recentSession.runSummary.writtenFiles.length > 0) {
          ctxParts.push(`上次已完成文件: ${recentSession.runSummary.writtenFiles.join(", ")}`);
        }
        if (recentSession.error) {
          ctxParts.push(`上次失败原因: ${recentSession.error}`);
        }
        if (recentSession.runSummary.keyCommands.length > 0) {
          ctxParts.push(`上次最后操作: ${recentSession.runSummary.keyCommands[recentSession.runSummary.keyCommands.length - 1]}`);
        }
        if (ctxParts.length > 0) {
          const contextText = `[Claw Monitor 跨spawn上下文] ${ctxParts.join(". ")}.`;
          await injectIntoSession(api, childKey, contextText, `cross-spawn-${childKey}`);
        }
      }

      // --- Create initial checkpoint ---
      writeCheckpoint(childKey, {
        version: 1,
        sessionKey: childKey,
        agentId: entry.agentId,
        task: entry.task || entry.label || "",
        label: entry.label || "",
        parentSessionKey: parentKey,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        type: "intermediate",
        outcome: "running",
        progress: createEmptyProgress(),
        metadata: entry.metadata || {}
      });

      // Schedule first intermediate checkpoint update 5 seconds after spawn
      // so the subagent's initial tool calls get captured early
      setTimeout(() => {
        const tracked = subagentTracker.get(childKey);
        if (tracked && !tracked.endedAt) {
          updateIntermediateCheckpoint(childKey, tracked, Date.now(), true);
        }
      }, 5000).unref?.();

      // --- Check for checkpoint to restore ---
      let checkpointToRestore = null;

      // Case 1: Agent has recent running checkpoint (orphan recovery — gateway restarted)
      // A "running" checkpoint means the session was interrupted before writing a final checkpoint
      const recentRunningCp = findCheckpointByAgentId(entry.agentId, childKey);
      if (recentRunningCp && recentRunningCp.outcome === "running") {
        checkpointToRestore = recentRunningCp;
      }

      // Case 2: Agent has recent failed/killed checkpoint (retry after failure)
      if (!checkpointToRestore && recentRunningCp &&
          (recentRunningCp.outcome === "failed" || recentRunningCp.outcome === "killed")) {
        checkpointToRestore = recentRunningCp;
      }

      // Inject checkpoint context if found
      if (checkpointToRestore && checkpointToRestore.progress) {
        const cp = checkpointToRestore;
        const ctxParts = [];
        ctxParts.push(`[Checkpoint 恢复] 你上次执行任务"${cp.task || cp.label}"时中断了。`);
        if (cp.progress.completedSteps?.length > 0)
          ctxParts.push(`已完成步骤: ${cp.progress.completedSteps.join(" → ")}`);
        if (cp.progress.writtenFiles?.length > 0)
          ctxParts.push(`已写入文件: ${cp.progress.writtenFiles.join(", ")}`);
        if (cp.progress.editedFiles?.length > 0)
          ctxParts.push(`已编辑文件: ${cp.progress.editedFiles.join(", ")}`);
        if (cp.progress.remainingSteps?.length > 0)
          ctxParts.push(`剩余步骤: ${cp.progress.remainingSteps.join(" → ")}`);
        if (cp.progress.lastError)
          ctxParts.push(`上次错误: ${cp.progress.lastError}`);
        if (cp.outcome === "failed")
          ctxParts.push(`上次结果: 失败。请分析失败原因并尝试不同策略。`);
        ctxParts.push(`请从断点继续，不要重复已完成的工作。`);
        await injectIntoSession(api, childKey, ctxParts.join(". ") + ".", `checkpoint-${childKey}`);
      }

      // Try to extract task from JSONL after a short delay (label may be empty)
      if (!event.label) {
        setTimeout(() => {
          const agentId = resolveAgentIdFromSessionKey(childKey);
          const sessionId = resolveSessionIdFromSessionKey(childKey);
          const filePath = findJsonlFile(agentId, sessionId);
          if (filePath) {
            const task = extractTaskFromJsonl(filePath);
            if (task) {
              const tracked = subagentTracker.get(childKey);
              if (tracked && !tracked.task) {
                tracked.task = task;
              }
            }
          }
        }, 3000);
      }
    });

    // Hook: subagent_ended — update tracker, generate summary, verify, auto-retry
    api.on("subagent_ended", async (event, ctx) => {
      const key = event.targetSessionKey;
      api.logger.info(`[claw-monitor] subagent_ended: ${key} outcome=${event.outcome} error=${event.error || "(none)"}`);
      const tracked = subagentTracker.get(key);
      if (tracked) {
        tracked.endedAt = event.endedAt || Date.now();
        tracked.outcome = event.outcome || "ended";
        tracked.error = event.error || null;
        if (event.error) {
          recentErrors.push({ sessionKey: key, error: event.error, ts: Date.now() });
          if (recentErrors.length > 100) recentErrors.shift();
        }
      } else {
        subagentTracker.set(key, hydrateEntryFromPersistentState(key, event, ctx));
        if (event.error) {
          recentErrors.push({ sessionKey: key, error: event.error, ts: Date.now() });
          if (recentErrors.length > 100) recentErrors.shift();
        }
      }

      const entry = subagentTracker.get(key);
      if (!entry) return;

      // --- 1. Update health stats ---
      const duration = entry.endedAt - entry.startedAt;
      updateAgentHealth(entry.agentId, entry.outcome, duration, entry.totalCostUsd || 0, entry.error);

	      // --- 2. Generate run summary, write final checkpoint, and inject into main session ---
	      if (!entry.label || !entry.task || !entry.parentSessionKey || !entry.startedAt) {
	        const hydrated = hydrateEntryFromPersistentState(key, event, ctx);
	        entry.agentId = entry.agentId || hydrated.agentId;
	        entry.task = entry.task || hydrated.task;
	        entry.label = entry.label || hydrated.label;
	        entry.parentSessionKey = entry.parentSessionKey || hydrated.parentSessionKey;
	        entry.startedAt = entry.startedAt || hydrated.startedAt;
	        entry.metadata = Object.keys(entry.metadata || {}).length > 0 ? entry.metadata : hydrated.metadata;
	        entry.progress = entry.progress || hydrated.progress;
	      }
	      const finalized = await finalizeSubagentCheckpoint(key, entry, apiRef, { injectSummary: true });
	      const runSummary = finalized?.runSummary || null;

      // --- 4. Verify result if verifyCommand was set ---
      let verifyResult = null;
      const metadata = entry.metadata || {};
      if (metadata.verifyCommand && isCommandSafe(metadata.verifyCommand)) {
        try {
          const output = execSync(metadata.verifyCommand, { timeout: 10000, encoding: "utf-8" }).trim();
          const expected = metadata.verifyExpected || "";
          const passed = expected ? output === expected : output.length > 0;
          verifyResult = { passed, output, expected };
          if (!passed) {
            await pushAlert("warning", key,
              `Subagent "${entry.label || entry.agentId}" (${key}) completed but VERIFICATION FAILED: expected "${expected}", got "${output}". ${metadata.verifyMessage || ""}`
            );
          }
        } catch (err) {
          verifyResult = { passed: false, output: err.message, expected: metadata.verifyExpected || "" };
          await pushAlert("warning", key,
            `Subagent "${entry.label || entry.agentId}" (${key}) verification command failed: ${err.message}`
          );
        }
      }

	      // --- 5. Verification failures are pushed separately above; final summary was injected during finalization. ---

      // --- 6. Auto-retry on retryable errors ---
      const retryCount = retryCounter.get(key) || 0;
      if (entry.outcome === "failed" && isRetryableError(entry.error) && retryCount < 2) {
        retryCounter.set(key, retryCount + 1);
        await pushAlert("info", key,
          `Subagent "${entry.label || entry.agentId}" (${key}) failed with retryable error: "${entry.error}". Auto-retrying (attempt ${retryCount + 1}/2)...`
        );

        // Build context for retry (prefer checkpoint data over runSummary)
        let retryContext = "";
        const retryCheckpoint = readCheckpoint(key);
        if (retryCheckpoint?.progress) {
          const cp = retryCheckpoint.progress;
          const completedFiles = [...(cp.writtenFiles || []), ...(cp.editedFiles || [])];
          if (completedFiles.length > 0) retryContext += `已有成果: ${completedFiles.join(", ")}. `;
          if (cp.completedSteps?.length > 0) retryContext += `已完成步骤: ${cp.completedSteps.join(" → ")}. `;
          if (cp.remainingSteps?.length > 0) retryContext += `剩余步骤: ${cp.remainingSteps.join(" → ")}. `;
          if (cp.hasErrors || runSummary?.hasErrors) retryContext += "上次有报错. ";
        } else if (runSummary) {
          const completedFiles = [...(runSummary.writtenFiles || []), ...(runSummary.editedFiles || [])];
          if (completedFiles.length > 0) retryContext += `已有成果: ${completedFiles.join(", ")}. `;
          if (runSummary.hasErrors) retryContext += "上次有报错. ";
        }
        retryContext += `上次失败原因: ${entry.error}. 请从断点继续.`;

        try {
          await apiRef.runtime.subagent.run({
            sessionKey: `${entry.agentId}:retry-${Date.now()}`,
            message: `${entry.label || entry.task || ""}\n\n${retryContext}`,
            extraSystemPrompt: retryContext,
          });
        } catch (spawnErr) {
          apiRef.logger?.warn(`[claw-monitor] Auto-retry spawn failed: ${spawnErr instanceof Error ? spawnErr.message : String(spawnErr)}`);
        }
      }

      // --- 7. Advance pipeline if this session is part of one ---
      await advancePipeline(key, apiRef);

      // --- 8. Write end marker to JSONL for file-discovery ---
      const endAgentId = resolveAgentIdFromSessionKey(key);
      const endSessionId = resolveSessionIdFromSessionKey(key);
      const endFilePath = findJsonlFile(endAgentId, endSessionId);
      if (endFilePath) {
        try {
          const endEvent = {
            type: "custom",
            customType: "claw-monitor-end",
            data: { outcome: entry.outcome, error: entry.error || null, ts: Date.now() },
            timestamp: new Date().toISOString()
          };
          fs.appendFileSync(endFilePath, JSON.stringify(endEvent) + "\n");
        } catch {}
      }
    });

    // Hook: before_prompt_build — capture main session key and flush alerts
    api.on("before_prompt_build", async (event, ctx) => {
      // Capture main agent's session key for push alerts
      if (ctx?.sessionKey) {
        if (!mainSessionKey) {
          mainSessionKey = ctx.sessionKey;
          api.logger.info(`[claw-monitor] before_prompt_build: captured mainSessionKey=${mainSessionKey}`);
        } else if (ctx.sessionKey !== mainSessionKey && !ctx.sessionKey.includes("subagent")) {
          mainSessionKey = ctx.sessionKey;
          api.logger.info(`[claw-monitor] before_prompt_build: updated mainSessionKey=${mainSessionKey}`);
        }
      }

      // Flush any remaining alerts that weren't pushed yet
      if (alertQueue.length > 0) {
        const alerts = [...alertQueue];
        alertQueue.length = 0;

        for (const alert of alerts) {
          if (mainSessionKey) {
            const method = await injectIntoSession(api, mainSessionKey, `[CLAW-MONITOR ${alert.level.toUpperCase()}] ${alert.message}`, `alert-${alert.sessionKey}-${alert.ts}`);
            if (method === "none") {
              // Re-queue if injection fails
              alertQueue.push(alert);
              break;
            }
          }
        }
      }

      // Flush deferred restart notification if mainSessionKey was captured just now
      if (pendingRestartNotification && mainSessionKey) {
        const notifyText = pendingRestartNotification;
        pendingRestartNotification = null;
        api.logger.info(`[claw-monitor] before_prompt_build: flushing deferred restart notification to mainSessionKey=${mainSessionKey}`);
        try {
          const jsonlOk = injectViaJsonl(mainSessionKey, notifyText);
          api.logger.info(`[claw-monitor] deferred restart notify: injectViaJsonl=${jsonlOk}`);
          await injectIntoSession(api, mainSessionKey, notifyText, `restart-notify-deferred-${Date.now()}`);
          if (apiRef?.runtime?.system?.requestHeartbeat) {
            apiRef.runtime.system.requestHeartbeat({ source: "claw-monitor", intent: "restart-recovery", reason: "deferred restart notification", sessionKey: mainSessionKey });
          }
        } catch (err) {
          api.logger.warn(`[claw-monitor] deferred restart notify failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    });

    // Hook: heartbeat_prompt_contribution — periodic status during idle
    api.on("heartbeat_prompt_contribution", async (event, ctx) => {
      const now = Date.now();
      const activeSubagents = [];
      const stuckSubagents = [];

      for (const [key, entry] of subagentTracker.entries()) {
        if (entry.endedAt) continue;
        const elapsed = now - entry.startedAt;
        const filePath = findJsonlFile(entry.agentId, resolveSessionIdFromSessionKey(key));
        let isStuck = false;
        let staleMs = 0;
        if (filePath) {
          try {
            const stat = fs.statSync(filePath);
            staleMs = now - stat.mtimeMs;
            if (staleMs > config.stuckThresholdMs) {
              // Use the same idle confirmation logic as the alert path
              const idleConfirmation = confirmIdleBeforeStuckAlert(key, entry, filePath, staleMs, config);
              isStuck = idleConfirmation.shouldAlert;
            }
          } catch {}
        }
        if (isStuck) {
          stuckSubagents.push(`${entry.label || entry.agentId} (${key}) - stuck for ${formatElapsed(staleMs)}`);
        } else {
          activeSubagents.push(`${entry.label || entry.agentId} (${key}) - running ${formatElapsed(elapsed)}`);
        }
      }

	      // --- Write intermediate checkpoints for running subagents ---
	      for (const [key, entry] of subagentTracker.entries()) {
	        updateIntermediateCheckpoint(key, entry, now);
	      }

      // --- Clean old checkpoints ---
      cleanOldCheckpoints();

      if (activeSubagents.length === 0 && stuckSubagents.length === 0 && alertQueue.length === 0) {
        return;
      }

      const parts = [];
      if (activeSubagents.length > 0) {
        parts.push(`Active subagents (${activeSubagents.length}): ${activeSubagents.join("; ")}`);
      }
      if (stuckSubagents.length > 0) {
        parts.push(`STUCK subagents (${stuckSubagents.length}): ${stuckSubagents.join("; ")}`);
      }
      if (alertQueue.length > 0) {
        parts.push(`Pending alerts: ${alertQueue.length}`);
      }

      return { appendContext: `[Claw Monitor] ${parts.join(". ")}` };
    });
  }
});
