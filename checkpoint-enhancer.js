/**
 * claw-monitor-checkpoint-enhancer.js
 * 
 * OpenClaw扩展补丁：增强subagent checkpoint的进度信息
 * 
 * 问题：97%的checkpoint的remainingSteps为空，导致恢复时不知道还剩什么
 * 原因：inferProgressFromJsonl依赖中文步骤标记，很多agent不用这种格式
 * 
 * 解决方案：
 * 1. 在每次checkpoint写入时，额外记录：tool调用序列、产出文件、错误记录、最后assistant消息
 * 2. 提供更可靠的进度推断（不依赖中文步骤标记）
 * 3. 支持从checkpoint自动生成恢复prompt
 * 
 * 安装方式：
 *   将此文件放到 ~/.openclaw/extensions/claw-monitor-checkpoint-enhancer/
 *   然后在 ~/.openclaw/config.yaml 中添加：
 *   extensions:
 *     claw-monitor-checkpoint-enhancer:
 *       enabled: true
 * 
 * 或者直接在claw-monitor的index.js中引入：
 *   在claw-monitor的hookSetup函数中调用 enhanceCheckpointHooks(api)
 * 
 * 作者：coder agent | 2026-05-10
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

// --- 配置 ---
const ENHANCER_CONFIG = {
  // 最大保留的tool调用记录数
  maxToolHistory: 30,
  // 最大保留的错误记录数
  maxErrorHistory: 5,
  // 最大保留的assistant消息摘要长度
  maxAssistantSummaryLen: 500,
  // 是否在checkpoint中包含tool参数摘要
  includeToolArgs: true,
  // tool参数摘要最大长度
  maxToolArgsLen: 100,
};

// Tool分类映射（英文版，不依赖中文标记）
const TOOL_CATEGORY_MAP = {
  // 搜索/调研
  "tavily_search": "research",
  "web_search": "research",
  "web_fetch": "research",
  "tavily_extract": "research",
  "memory_recall": "research",
  "memory_search": "research",
  "lcm_grep": "research",
  "lcm_expand_query": "research",
  "lcm_expand": "research",
  "lcm_describe": "research",
  
  // 代码/实现
  "exec": "implementation",
  "write": "implementation",
  "edit": "implementation",
  "read": "implementation",
  "process": "implementation",
  
  // 浏览器
  "browser": "browser",
  "chrome-devtools__click": "browser",
  "chrome-devtools__take_snapshot": "browser",
  "chrome-devtools__navigate_page": "browser",
  "chrome-devtools__fill": "browser",
  "chrome-devtools__evaluate_script": "browser",
  
  // 生成
  "image_generate": "generation",
  "video_generate": "generation",
  "music_generate": "generation",
  "tts": "generation",
  
  // 文档
  "pdf": "documentation",
  
  // 会话管理
  "sessions_spawn": "orchestration",
  "sessions_send": "orchestration",
  "subagent_steer": "orchestration",
  "subagent_kill": "orchestration",
  "subagent_watch": "orchestration",
  "subagent_progress": "orchestration",
  
  // 记忆存储
  "memory_store": "archival",
  "memory_forget": "archival",
  
  // 其他
  "image": "analysis",
  "canvas": "presentation",
};

// 推断任务阶段顺序
const PHASE_ORDER = ["research", "analysis", "implementation", "testing", "generation", "documentation", "archival", "orchestration", "presentation"];

/**
 * 从JSONL日志中提取增强进度信息
 */
function extractEnhancedProgress(jsonlPath, existingProgress = {}) {
  if (!jsonlPath || !fs.existsSync(jsonlPath)) {
    return { enhancedProgress: null, reason: "jsonl_not_found" };
  }
  
  try {
    // 读取最近的events
    const stat = fs.statSync(jsonlPath);
    const fileSize = stat.size;
    const readSize = Math.min(fileSize, 256 * 1024); // 最多读256KB
    const buffer = Buffer.alloc(readSize);
    const fd = fs.openSync(jsonlPath, "r");
    const offset = Math.max(0, fileSize - readSize);
    fs.readSync(fd, buffer, 0, readSize, offset);
    fs.closeSync(fd);
    
    const content = buffer.toString("utf-8");
    const lines = content.split("\n").filter(l => l.trim());
    
    const toolHistory = [];
    const errors = [];
    const assistantSummaries = [];
    const writtenFiles = new Set(existingProgress.writtenFiles || []);
    const editedFiles = new Set(existingProgress.editedFiles || []);
    const categoriesSeen = new Set();
    
    for (const line of lines) {
      let evt;
      try { evt = JSON.parse(line); } catch { continue; }
      if (evt.type !== "message" || !evt.message) continue;
      const msg = evt.message;
      
      // 提取tool调用
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "tool_use" || block.type === "toolCall") {
            const toolName = block.name || "unknown";
            const category = TOOL_CATEGORY_MAP[toolName] || "other";
            categoriesSeen.add(category);
            
            const entry = { tool: toolName, category };
            if (ENHANCER_CONFIG.includeToolArgs && block.input) {
              const argsStr = JSON.stringify(block.input);
              entry.argsPreview = argsStr.substring(0, ENHANCER_CONFIG.maxToolArgsLen);
              
              // 提取文件路径
              if (toolName === "write" && block.input.path) writtenFiles.add(block.input.path);
              if (toolName === "edit" && block.input.path) editedFiles.add(block.input.path);
            }
            
            toolHistory.push(entry);
          }
          
          // 提取assistant文本
          if (block.type === "text" && block.text) {
            const text = block.text.trim();
            if (text && !text.startsWith("[assistant turn failed")) {
              assistantSummaries.push(text.substring(0, ENHANCER_CONFIG.maxAssistantSummaryLen));
            }
          }
        }
      }
      
      // 提取错误
      if (msg.role === "toolResult" || msg.role === "tool") {
        const content = msg.content;
        const text = typeof content === "string" ? content : 
                     Array.isArray(content) ? content.map(c => c.text || "").join("") : "";
        if (text.toLowerCase().includes("error") || text.toLowerCase().includes("failed")) {
          errors.push({
            preview: text.substring(0, 200),
            timestamp: new Date().toISOString()
          });
        }
      }
    }
    
    // 推断进度
    const completedPhases = PHASE_ORDER.filter(p => categoriesSeen.has(p));
    const remainingPhases = inferRemainingPhases(completedPhases, existingProgress);
    const estimatedProgress = estimateProgress(completedPhases, toolHistory.length);
    
    return {
      enhancedProgress: {
        // 保留原有的
        ...existingProgress,
        // 新增的增强信息
        toolHistory: toolHistory.slice(-ENHANCER_CONFIG.maxToolHistory),
        toolCategories: [...categoriesSeen],
        completedPhases,
        remainingPhases,
        estimatedProgress,
        writtenFiles: [...writtenFiles],
        editedFiles: [...editedFiles],
        recentErrors: errors.slice(-ENHANCER_CONFIG.maxErrorHistory),
        lastAssistantSummary: assistantSummaries.length > 0 
          ? assistantSummaries[assistantSummaries.length - 1] 
          : null,
        toolCallCount: toolHistory.length,
        enhancedAt: new Date().toISOString(),
        enhancerVersion: "1.0.0",
      }
    };
  } catch (err) {
    return { enhancedProgress: null, reason: `error: ${err.message}` };
  }
}

/**
 * 推断剩余阶段
 */
function inferRemainingPhases(completedPhases, existingProgress) {
  const remaining = [];
  const has = new Set(completedPhases);
  
  // 如果有research但没有implementation，可能还需要实现
  if (has.has("research") && !has.has("implementation")) {
    remaining.push("implementation");
  }
  // 如果有implementation但没有archival，可能还需要归档
  if (has.has("implementation") && !has.has("archival")) {
    remaining.push("archival");
  }
  // 如果有research但没有analysis，可能还需要分析
  if (has.has("research") && !has.has("analysis") && !has.has("implementation")) {
    remaining.push("analysis");
  }
  
  // 合并existingProgress中的remainingSteps
  const existingRemaining = existingProgress.remainingSteps || [];
  for (const step of existingRemaining) {
    if (!remaining.includes(step)) {
      remaining.push(step);
    }
  }
  
  return remaining;
}

/**
 * 估算进度百分比
 */
function estimateProgress(completedPhases, toolCallCount) {
  let base = 0;
  
  // 基于阶段
  if (completedPhases.includes("research")) base += 20;
  if (completedPhases.includes("analysis")) base += 15;
  if (completedPhases.includes("implementation")) base += 30;
  if (completedPhases.includes("testing")) base += 10;
  if (completedPhases.includes("documentation")) base += 10;
  if (completedPhases.includes("archival")) base += 10;
  if (completedPhases.includes("generation")) base += 15;
  
  // 基于tool调用数量（越多越可能接近完成）
  if (toolCallCount > 20) base = Math.min(base + 10, 95);
  else if (toolCallCount > 10) base = Math.min(base + 5, 90);
  
  return Math.min(base, 95); // 永远不标100%，因为还没完成
}

/**
 * 生成恢复prompt
 */
function generateRecoveryPrompt(checkpoint) {
  const progress = checkpoint.enhancedProgress || checkpoint.progress || {};
  
  const parts = [
    `## 恢复任务：${checkpoint.task || "unknown"}`,
    "",
    "### 原始上下文",
    `- Agent: ${checkpoint.agentId || "unknown"}`,
    `- 标签: ${checkpoint.label || ""}`,
    `- Checkpoint置信度: ${progress.confidence || 0}`,
    `- 估算进度: ${progress.estimatedProgress || 0}%`,
    "",
    "### 已完成阶段",
    ...(progress.completedPhases || []).map(p => `- ✅ ${p}`),
    "",
    "### 剩余阶段",
    ...(progress.remainingPhases || progress.remainingSteps || []).map(p => `- ⏳ ${p}`),
    "",
    "### 产出文件",
    ...(progress.writtenFiles || []).map(f => `- 📝 ${f}`),
    ...(progress.editedFiles || []).map(f => `- ✏️ ${f}`),
    "",
  ];
  
  if (progress.recentErrors && progress.recentErrors.length > 0) {
    parts.push("### 最近错误");
    for (const err of progress.recentErrors) {
      parts.push(`- ❌ ${err.preview}`);
    }
    parts.push("");
  }
  
  if (progress.lastAssistantSummary) {
    parts.push("### 最后assistant输出");
    parts.push(progress.lastAssistantSummary);
    parts.push("");
  }
  
  if (progress.toolHistory && progress.toolHistory.length > 0) {
    parts.push("### 最近tool调用");
    const recent = progress.toolHistory.slice(-10);
    for (const tc of recent) {
      parts.push(`- ${tc.tool} [${tc.category}]${tc.argsPreview ? ": " + tc.argsPreview : ""}`);
    }
    parts.push("");
  }
  
  parts.push("### 恢复指令");
  parts.push("请从上次中断的地方继续执行。参考以上信息判断：");
  parts.push("1. 哪些阶段已完成（不要重复执行）");
  parts.push("2. 哪些阶段还需要执行");
  parts.push("3. 如果有产出文件，先检查它们的内容和完整性");
  parts.push("4. 如果有错误，分析是否需要换策略");
  parts.push("5. 完成后务必归档经验到memory_store");
  
  return parts.join("\n");
}

/**
 * 增强claw-monitor的checkpoint hooks
 * 
 * 使用方式：在claw-monitor的hookSetup中调用此函数
 */
function enhanceCheckpointHooks(api) {
  if (!api) {
    console.error("[checkpoint-enhancer] API对象为空，无法增强");
    return;
  }
  
  // 监听session事件，在每次checkpoint写入后增强
  api.on("session:checkpoint:write", (data) => {
    try {
      const { sessionKey, checkpoint } = data;
      if (!sessionKey || !checkpoint) return;
      
      // 只增强subagent的checkpoint
      if (!sessionKey.includes("subagent")) return;
      
      // 查找JSONL文件
      const agentId = sessionKey.split(":")[1];
      const sessionId = sessionKey.split(":").slice(-1)[0];
      const jsonlPath = findJsonlPath(agentId, sessionId);
      
      if (jsonlPath) {
        const { enhancedProgress } = extractEnhancedProgress(jsonlPath, checkpoint.progress);
        if (enhancedProgress) {
          // 合并增强信息到checkpoint
          checkpoint.enhancedProgress = enhancedProgress;
          
          // 如果remainingSteps为空，用推断的填充
          if ((!checkpoint.progress.remainingSteps || checkpoint.progress.remainingSteps.length === 0) 
              && enhancedProgress.remainingPhases.length > 0) {
            checkpoint.progress.remainingSteps = enhancedProgress.remainingPhases;
            checkpoint.progress.confidence = Math.max(
              checkpoint.progress.confidence || 0,
              0.3
            );
          }
          
          // 重新写入checkpoint
          const cpDir = path.join(resolveOpenclawDir(), "checkpoints");
          const cpPath = path.join(cpDir, `${sessionKey.replace(/:/g, "_")}.json`);
          if (fs.existsSync(cpDir)) {
            checkpoint.updatedAt = new Date().toISOString();
            fs.writeFileSync(cpPath, JSON.stringify(checkpoint, null, 2));
          }
        }
      }
    } catch (err) {
      // 静默失败，不影响主流程
      console.error(`[checkpoint-enhancer] 增强失败: ${err.message}`);
    }
  });
  
  console.log("[checkpoint-enhancer] Checkpoint增强hooks已注册");
}

/**
 * 查找JSONL文件路径
 */
function findJsonlPath(agentId, sessionId) {
  const openclawDir = resolveOpenclawDir();
  const sessionsDir = path.join(openclawDir, "agents", agentId, "sessions");
  
  // 从sessions.json中查找
  const sessionsFile = path.join(sessionsDir, "sessions.json");
  if (fs.existsSync(sessionsFile)) {
    try {
      const sessions = JSON.parse(fs.readFileSync(sessionsFile, "utf-8"));
      for (const [key, entry] of Object.entries(sessions)) {
        if (key.includes(sessionId) && entry.sessionFile) {
          return entry.sessionFile;
        }
      }
    } catch {}
  }
  
  // 直接查找文件
  if (fs.existsSync(sessionsDir)) {
    const files = fs.readdirSync(sessionsDir).filter(f => f.includes(sessionId) && f.endsWith(".jsonl"));
    if (files.length > 0) {
      return path.join(sessionsDir, files[0]);
    }
  }
  
  return null;
}

function resolveOpenclawDir() {
  return process.env.OPENCLAW_DIR || path.join(os.homedir(), ".openclaw");
}

// --- 导出 ---
module.exports = {
  extractEnhancedProgress,
  generateRecoveryPrompt,
  enhanceCheckpointHooks,
  inferRemainingPhases,
  estimateProgress,
  TOOL_CATEGORY_MAP,
  PHASE_ORDER,
};
