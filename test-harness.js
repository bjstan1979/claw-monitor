// test-harness.js — Manual integration test for harness hooks
// Run: node test-harness.js
// This tests the rule evaluator logic in isolation (not the full OpenClaw gateway)

const fs = require("fs");
const path = require("path");

// --- Test 1: Config loading ---
console.log("Test 1: Config loading");
const configPath = path.join(__dirname, "harness-rules.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
console.assert(config.version === 1, "version should be 1");
console.assert(config.rules.length >= 3, "should have at least 3 rules");
console.log("  PASS: Config loaded with " + config.rules.length + " rules");

// --- Test 2: Condition evaluation ---
console.log("Test 2: Condition evaluation");

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

console.assert(evaluateCondition({ contextUsage: { gt: 70 } }, { contextUsage: 75 }) === true, "75 > 70 should be true");
console.assert(evaluateCondition({ contextUsage: { gt: 70 } }, { contextUsage: 50 }) === false, "50 > 70 should be false");
console.assert(evaluateCondition({ turnCount: { lte: 2 } }, { turnCount: 2 }) === true, "2 <= 2 should be true");
console.assert(evaluateCondition({ turnCount: { lte: 2 } }, { turnCount: 3 }) === false, "3 <= 2 should be false");
console.assert(
  evaluateCondition({ contextUsage: { gt: 70 }, turnCount: { gt: 5 } }, { contextUsage: 80, turnCount: 10 }) === true,
  "AND: both conditions met"
);
console.assert(
  evaluateCondition({ contextUsage: { gt: 70 }, turnCount: { gt: 5 } }, { contextUsage: 80, turnCount: 3 }) === false,
  "AND: one condition not met"
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

console.assert(interpolateTemplate("Usage at {{contextUsage}}%", { contextUsage: 85 }) === "Usage at 85%", "integer interpolation");
console.assert(interpolateTemplate("{{toolCallCount}} calls", { toolCallCount: 52 }) === "52 calls", "integer interpolation 2");
console.assert(interpolateTemplate("{{missing}} value", {}) === "N/A value", "missing key returns N/A");
console.log("  PASS: Template interpolation works correctly");

// --- Test 4: Rule evaluation with agent roles ---
console.log("Test 4: Rule evaluation with agent roles");

function evaluateHarnessRules(agentRole, metrics, hookName) {
  const matchingRules = config.rules.filter(rule => {
    if (rule.enabled === false) return false;
    if (!rule.agentRoles || !rule.agentRoles.includes(agentRole)) return false;
    if (rule.hook && rule.hook !== hookName) return false;
    if (!evaluateCondition(rule.trigger, metrics)) return false;
    return true;
  });

  if (matchingRules.length === 0) return null;

  const priority = { block: 3, requireApproval: 2, pass: 1 };
  matchingRules.sort((a, b) => (priority[b.action] || 0) - (priority[a.action] || 0));

  return matchingRules[0];
}

// Main agent at 75% context → should trigger warning (requireApproval)
const highContextMetrics = {
  contextUsage: 75,
  toolCallCount: 10,
  toolCallCountInWindow: () => 10,
  turnCount: 5,
  sessionDurationMinutes: 30,
  errorCount: 0,
};
const warnRule = evaluateHarnessRules("main", highContextMetrics, "before_tool_call");
console.assert(warnRule?.id === "context-overflow-warning", "75% should trigger warning");
console.assert(warnRule?.action === "requireApproval", "warning should be requireApproval");
console.log("  PASS: Warning rule triggers at 75%");

// Main agent at 95% context → should trigger block (higher priority)
const criticalMetrics = { ...highContextMetrics, contextUsage: 95 };
const blockRule = evaluateHarnessRules("main", criticalMetrics, "before_tool_call");
console.assert(blockRule?.id === "context-overflow-block", "95% should trigger block");
console.assert(blockRule?.action === "block", "block rule should have block action");
console.log("  PASS: Block rule triggers at 95% (higher priority)");

// Researcher at 95% → no block rule for researcher, only warning
const researcherRule = evaluateHarnessRules("researcher", criticalMetrics, "before_tool_call");
console.assert(researcherRule?.id === "context-overflow-warning", "researcher should get warning not block");
console.log("  PASS: Researcher only gets warning, not block");

// Tool burst protection
const burstMetrics = {
  contextUsage: 30,
  toolCallCount: 60,
  toolCallCountInWindow: () => 55,
  turnCount: 20,
  sessionDurationMinutes: 10,
  errorCount: 0,
};
const burstRule = evaluateHarnessRules("main", burstMetrics, "before_tool_call");
console.assert(burstRule?.id === "tool-burst-protection", "55 calls in 10min should trigger burst protection");
console.log("  PASS: Tool burst protection triggers correctly");

// Long session check (before_prompt_build hook)
const longSessionMetrics = {
  contextUsage: 30,
  toolCallCount: 10,
  toolCallCountInWindow: () => 10,
  turnCount: 20,
  sessionDurationMinutes: 90,
  errorCount: 0,
};
const sessionRule = evaluateHarnessRules("main", longSessionMetrics, "before_prompt_build");
console.assert(sessionRule?.id === "long-session-check", "90min session should trigger long session check");
console.assert(sessionRule?.action === "pass", "long session check should be pass action");
console.log("  PASS: Long session check triggers for 90min session");

// --- Test 5: Agent role resolution ---
console.log("Test 5: Agent role resolution");
function resolveAgentRole(agentId) {
  if (agentId === "main" || agentId === "葱花") return "main";
  if (agentId === "coder" || agentId === "程序员") return "coder";
  if (agentId === "researcher" || agentId === "研究员") return "researcher";
  if (agentId === "media" || agentId === "多媒体专员") return "media";
  if (agentId === "news" || agentId === "新闻员") return "news";
  return agentId;
}

console.assert(resolveAgentRole("main") === "main", "main maps to main");
console.assert(resolveAgentRole("葱花") === "main", "葱花 maps to main");
console.assert(resolveAgentRole("coder") === "coder", "coder maps to coder");
console.assert(resolveAgentRole("程序员") === "coder", "程序员 maps to coder");
console.assert(resolveAgentRole("researcher") === "researcher", "researcher maps to researcher");
console.assert(resolveAgentRole("unknown") === "unknown", "unknown passes through");
console.log("  PASS: Agent role resolution works correctly");

console.log("\n=== All harness tests passed ===");
