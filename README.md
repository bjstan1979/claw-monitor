# Claw-Monitor

OpenClaw 子代理监控与 Harness 规则引擎插件。为主代理（葱花）提供对子代理执行的实时可见性、主动告警、进度追踪、自动恢复，以及基于规则的实时拦截与上下文注入。

## 功能概览

| 功能 | 描述 | 触发方式 |
|------|------|---------|
| **子代理状态追踪** | 实时追踪所有子代理的运行状态、进度、产出文件 | 轮询（30s） |
| **主动告警** | 子代理卡住/超时/成本过高时自动告警主代理 | 轮询检测 |
| **自动恢复** | 卡住时自动 steer、上下文溢出时自动 spawn 接续 | 告警触发 |
| **重启恢复** | 网关重启后自动发现被中断的子代理/cron session 并通知主代理 | 启动时扫描 |
| **Pipeline 编排** | 顺序执行多步子代理任务，自动传递产出文件 | 工具调用 |
| **Checkpoint 系统** | 持久化子代理进度，支持中断恢复 | 轮询刷新 |
| **Harness 规则引擎** | 实时评估规则，block/requireApproval/pass 工具调用 | Hook 事件驱动 |
| **铁律注入** | 每轮 prompt 强制注入行为规则 | before_prompt_build |
| **Agent 控制模式** | requireApproval 由主代理决策，不依赖 UI 审核 | Hook + 注入 |

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│                      index.js (4342行)                       │
│                                                             │
│  ┌──────────────────┐  ┌──────────────────────────────────┐ │
│  │  Monitor Loop    │  │  Harness Layer (事件驱动)         │ │
│  │  (轮询式)        │  │                                  │ │
│  │                  │  │  before_tool_call → 规则评估      │ │
│  │  - 状态追踪      │  │  after_tool_call  → 错误计数      │ │
│  │  - 告警检测      │  │  message_sending  → 通知注入      │ │
│  │  - Checkpoint    │  │  before_prompt_build → 铁律注入   │ │
│  │  - 重启恢复      │  │                                  │ │
│  └────────┬─────────┘  └────────────┬─────────────────────┘ │
│           │                         │                       │
│           └──────────┬──────────────┘                       │
│                      │                                      │
│             共享状态 (module vars)                            │
│             - trackedSubagents (Map)                        │
│             - checkpointState (Map)                         │
│             - harnessSessionMetrics (Map)                   │
│             - harnessPendingNotifications (Array)           │
│             - agentHealth (Map)                             │
└─────────────────────────────────────────────────────────────┘
                       │
           ┌───────────┴───────────┐
           │  配置文件              │
           │  - harness-rules.json │
           │  - iron-laws.json     │
           │  - openclaw.plugin.json│
           └───────────────────────┘
```

## 工具列表

插件注册了以下工具，供主代理和子代理调用：

| 工具 | 用途 |
|------|------|
| `subagent_status` | 列出所有子代理的运行状态、进度、成本、产出 |
| `subagent_watch` | 读取子代理的最近 transcript（digest/summary/full 三种粒度） |
| `subagent_kill` | 终止卡住或不需要的子代理 |
| `subagent_progress` | 查询子代理进度（支持 checkCommand 自动执行） |
| `subagent_search` | 按关键词搜索历史和活跃子代理 |
| `subagent_steer` | 向活跃子代理注入转向指令 |
| `subagent_on_alert` | 查询待处理的告警（卡住/超时/成本过高/错误激增） |
| `subagent_pipeline` | 定义顺序执行的子代理流水线 |
| `subagent_checkpoint` | 列出/读取/删除子代理的 checkpoint |
| `harness_status` | 查看 Harness 规则配置和当前会话指标 |
| `harness_log` | 查看最近的规则触发记录 |

## Monitor Loop（轮询式监控）

### 子代理生命周期

```
spawn → running → (stuck? → auto-steer → still stuck? → alert)
                → completed/failed/timeout → finalize checkpoint → notify main
```

### 状态追踪

- **发现机制**：`discoverRunningSubagentsFromSessionsJson()` 扫描 `sessions.json`，发现所有 `status=running` 的子代理
- **过期清理**：`pruneStaleTrackedSubagents()` 清理超过 60 分钟无活动的追踪记录
- **结束处理**：`finalizeEndedSessionsFromSessionsJson()` 检测已结束的子代理，生成摘要并通知主代理

### 告警检测

`checkAlerts()` 每 30 秒运行一次，检测以下条件：

| 告警类型 | 条件 | 自动动作 |
|---------|------|---------|
| 卡住 | 无活动超过 stuckThresholdMinutes（默认5分钟） | 自动 steer（首次）；二次卡住仅告警 |
| 成本过高 | 累计成本超过 costAlertThresholdUsd（默认$5） | 告警 |
| Token 过多 | 累计 token 超过 tokenAlertThreshold（默认100K） | 告警 |
| 错误激增 | 连续错误数超过阈值 | 告警 |

### 空闲确认机制

当 `requireIdleConfirmation=true`（默认），卡住检测会先确认子代理确实空闲（无进程活动、无模型生成），避免误报。

### Checkpoint 系统

- **持久化**：进度写入 `~/.openclaw/checkpoints/<sessionKey>.json`
- **刷新**：每 60 秒从 JSONL 推断进度并更新 checkpoint
- **内容**：包含 task、agentId、progress（completedSteps/remainingSteps/writtenFiles）、outcome
- **恢复**：重启后从 checkpoint 恢复追踪状态
- **清理**：超过 7 天的 checkpoint 自动清理

### 进度推断

`inferProgressFromJsonl()` 从 JSONL 事件流推断子代理的执行进度：

1. **Strategy-1 Phase A**：识别工具调用阶段（search → read → write → test）
2. **Strategy-1 Phase B**：统计各阶段工具调用次数
3. **Strategy-1 Phase C**：将步骤编号映射到工具阶段
4. 与已有 checkpoint 比对，仅更新有变化的部分

### 重启恢复

`discoverAbortedSubagentsAndNotifyMain()` 在网关启动时扫描 `sessions.json`，检测被中断的子代理：

**Condition 1 — 显式中断**：
- `abortedLastRun=true`、`status=failed`、`status=timeout`、`status=running`

**Condition 2 — 陈旧未结束（2026-05-10 新增）**：
- `!isTerminal && !endedAt && hasActivity && withinStaleWindow`
- 捕获重启后 status=null、abortedLastRun=null 的 cron/dashboard session
- 时间窗口：cron/dashboard 6小时，subagent 24小时

**去重机制**：
- 已 finalized 的 checkpoint 跳过
- 已标记 `restartNotifiedAt` 的跳过
- 超过 maxAgeMs 的跳过

### 自动恢复

#### 卡住自动 Steer

当 `autoSteerOnStuck=true`（默认），首次检测到卡住时自动注入 steer 消息：
```
[CLAW-MONITOR] 检测到你的任务可能卡住了（{N}分钟无活动）。请检查当前状态，如果遇到问题请尝试换一种方式继续。如果任务已完成，请 announce 结果。
```

#### 上下文溢出自动 Spawn

当 Harness 检测到上下文 > 90% 并 block 工具调用时，`autoSpawnOnContextOverflow()` 自动：
1. 读取当前子代理的 checkpoint
2. 生成接续任务描述（包含已完成步骤、剩余工作、产出文件）
3. Spawn 新子代理接续
4. 向主代理发送通知

### Agent 健康追踪

`updateAgentHealth()` / `getAgentHealth()` 追踪每个 agent 的历史表现：
- 成功/失败/超时次数
- 平均执行时长
- 累计成本
- 用于 Pipeline 编排时选择最合适的 agent

## Harness 规则引擎（事件驱动）

### 工作原理

```
Agent 调用工具 → before_tool_call hook → 加载规则 → 评估条件 → {block|requireApproval|pass}
                                                          ↓
                                              更新 session metrics
```

### 当前生效的规则

| 规则 ID | 触发条件 | 适用角色 | 动作 | 超时行为 |
|---------|---------|---------|------|---------|
| context-overflow-warning | 上下文 > 70% | main, coder, researcher, media, news | requireApproval | 30s 超时后放行 |
| context-overflow-block | 上下文 > 90% | main, coder, researcher, media, news, doctor | block | 直接拒绝 + 自动 spawn |
| tool-burst-protection | 10分钟内 > 50次工具调用 | main | requireApproval | 15s 超时后放行 |
| long-session-check | 会话运行 > 60分钟 | main, coder, researcher | pass | prompt 注入提醒 |
| error-retry-limit | 同工具同错误 ≥ 6次 | main, coder, researcher | requireApproval | 30s 超时后拒绝 |

### 条件 DSL

```json
{
  "contextUsage": { "gt": 70 },
  "toolCallCountInWindow": { "gt": 50, "windowMinutes": 10 },
  "sessionDurationMinutes": { "gt": 60 },
  "errorCountByGroup": { "gte": 6 }
}
```

支持的字段：`contextUsage`、`toolCallCount`、`toolCallCountInWindow`、`turnCount`、`sessionDurationMinutes`、`errorCount`、`errorCountByGroup`

比较运算符：`gt`、`lt`、`gte`、`lte`、`eq`

多条件之间 AND 逻辑。

### 上下文使用率估算

`estimateContextUsage()` 的估算策略：

1. **优先**：从 JSONL 最后一条 assistant 消息的 `usage` 字段读取 `totalTokens`
2. **回退**：从 JSONL 文件大小估算（1KB ≈ 300 tokens）
3. **模型窗口**：从 `openclaw.json` 的模型配置读取 `contextWindow`（不再硬编码）
4. **冷却**：60 秒内不重复读取 JSONL，避免频繁 IO

### Agent 控制模式

当 `agentApproval: true`（默认），`requireApproval` 规则由主代理（葱花）控制：

1. 触发时向主代理 session 注入通知
2. `timeoutBehavior: "allow"` → 放行，主代理可事后 steer/kill
3. `timeoutBehavior: "deny"` → 阻止，主代理可通过 `HARNESS_ALLOW <ruleId>` 放行

放行方式：
- `sessions_send(sessionKey="<子agent>", message="HARNESS_ALLOW error-retry-limit")`
- `subagent_steer(sessionKey="<子agent>", message="HARNESS_ALLOW error-retry-limit")`
- 创建标记文件 `touch /tmp/harness-allow/<sessionKey>__<ruleId>`

### 铁律注入

`before_prompt_build` hook 每轮强制注入铁律摘要。内容来自 `iron-laws.json`，支持热加载。

**通用铁律（8条）**：
1. 先查记忆再动手
2. 做完必交付
3. 安全红线不碰
4. 先说判断再行动
5. 修完必记录
6. 失败必重试
7. 不理解就不动手
8. 重启需上报

**角色专属铁律**（替换第2条）：

| Agent | 专属铁律 |
|-------|---------|
| coder | 能修就修，发现bug先查Github有没有PR/commit |
| media | 每步验证效果 + 交付前自检 |
| researcher | 任务太大就拆 |
| news | 忠实原文 |
| doctor | 医疗免责 |

### 通知前缀

| 前缀 | 来源 |
|------|------|
| `[CLAW-MONITOR]` | Monitor Loop 的通知（告警、checkpoint、pipeline） |
| `[HARNESS]` | Harness 规则评估通知 |
| `[HARNESS 铁律]` | 铁律强制注入 |

## Pipeline 编排

`subagent_pipeline` 定义顺序执行的子代理流水线：

```
Step A → outputFiles → Step B → outputFiles → Step C
```

- 每步完成时 `advancePipeline()` 自动 spawn 下一步
- 上一步的 `outputFiles` 注入到下一步的 task 描述中
- 支持 metadata（successCriteria、expectedDuration、checkCommand）

## 配置

### openclaw.plugin.json 配置项

| 属性 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enabled` | boolean | true | 启用插件 |
| `stuckThresholdMinutes` | number | 5 | 卡住检测阈值（分钟） |
| `requireIdleConfirmation` | boolean | true | 卡住检测需确认空闲 |
| `maxWatchLines` | number | 200 | watch 工具最大行数 |
| `costAlertThresholdUsd` | number | 5 | 成本告警阈值（USD） |
| `tokenAlertThreshold` | number | 100000 | Token 告警阈值 |
| `alertCheckIntervalSeconds` | number | 30 | 告警检查间隔（秒） |
| `checkpointRefreshIntervalSeconds` | number | 60 | Checkpoint 刷新间隔（秒） |
| `orphanGraceMinutes` | number | 60 | 孤儿 session 宽限期（分钟） |
| `autoSteerOnStuck` | boolean | true | 卡住时自动 steer |
| `harnessEnabled` | boolean | true | 启用 Harness |
| `harnessRulesPath` | string | "harness-rules.json" | 规则配置文件路径 |
| `harnessLogEnabled` | boolean | true | 启用 Harness 日志 |
| `harnessDefaultAction` | string | "pass" | 默认动作 |

### 配置文件

| 文件 | 热加载 | 说明 |
|------|--------|------|
| `harness-rules.json` | 是（mtime 缓存） | 规则配置 |
| `iron-laws.json` | 是（mtime 缓存） | 铁律内容 |

## 文件清单

| 文件 | 说明 |
|------|------|
| `index.js` | 全部逻辑（Monitor Loop + Harness） |
| `openclaw.plugin.json` | 插件元数据和配置 schema |
| `harness-rules.json` | Harness 规则配置 |
| `iron-laws.json` | 铁律内容配置 |
| `test-harness.js` | Harness 集成测试 |
| `HARNESS.md` | Harness 功能详细说明 |
| `README.md` | 本文件 |
| `docs/superpowers/` | 设计文档和实施计划 |

## 开发历史

| 日期 | 里程碑 |
|------|--------|
| 2026-05-07 | 初始版本：子代理状态追踪、告警、checkpoint |
| 2026-05-07 | Pipeline 编排 |
| 2026-05-07 | 进度推断（Strategy-1 Phase A/B/C） |
| 2026-05-07 | Harness 规则引擎（before_tool_call + message_sending + before_prompt_build） |
| 2026-05-07 | 铁律注入 |
| 2026-05-08 | Agent 控制模式（requireApproval 由主代理决策） |
| 2026-05-08 | 错误重试限制（按工具+错误类型分组计数） |
| 2026-05-09 | 上下文使用率估算优化（JSONL usage + 模型 contextWindow） |
| 2026-05-09 | 自动 steer（卡住时）+ 自动 spawn（上下文溢出时） |
| 2026-05-10 | 陈旧未结束 session 检测（重启后 cron session 不漏报） |
