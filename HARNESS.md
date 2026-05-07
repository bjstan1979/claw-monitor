# Claw-Monitor Harness 功能说明

## 概述

Harness 是 claw-monitor 插件新增的实时监控层，通过 OpenClaw 插件 SDK 的 hook 机制在工具调用、消息发送、prompt 构建等环节拦截并评估规则。不同于原有的轮询式监控（每隔几十秒检查一次），Harness 是事件驱动的——每次工具调用都会实时触发规则评估。

## 工作原理

当 agent 执行任何工具调用时，Gateway 会先触发 `before_tool_call` hook。Harness 在这个 hook 中：

1. 记录本次工具调用到会话指标（toolCallCount、turnCount）
2. 读取当前会话的上下文使用率、工具调用频率、会话时长等指标
3. 用这些指标逐条评估 `harness-rules.json` 中匹配当前 agent 角色的规则
4. 根据匹配规则的 action 返回结果：
   - `block` → 工具调用被拒绝，agent 收到拒绝消息
   - `requireApproval` → 请求人工确认（Control UI 有确认按钮；CLI/聊天渠道走超时机制）
   - `pass` → 不拦截，但可以在 prompt 中注入提醒文本

## 铁律强制注入

每轮 prompt 构建时，`before_prompt_build` hook 会自动注入铁律摘要。铁律内容来自 `iron-laws.json` 配置文件，不是硬编码的——改文件就能调整，无需改代码。

### 通用铁律（7条，所有 agent 共有）

1. 先查记忆再动手 — MEMORY.md + memory_recall + lcm_grep，不要从零摸索
2. 做完必交付 — 所有步骤完成后主动announce结果并结束，不要干等后续指令
3. 安全红线不碰 — 社交写操作、金融操作，一律上报等批准
4. 先说判断再行动 — 发现更优路径时，先告诉调度员你的判断
5. 修完必记录 — 解决了什么问题、怎么解决的，写进MEMORY.md
6. 失败必重试 — 遇到错误先分析原因，能修就修/能重试就重试，最多重试2次，超过2次上报
7. 不理解就不动手 — 不理解根因就去搜网络、查文档、读源码、做小实验验证假设（coder除外）

### 角色专属铁律（替换第2条）

| Agent | 专属铁律 |
|-------|---------|
| coder | 能修就修，不卡住 — 小问题自己解决，大问题上报 |
| media | 每步验证效果 + 交付前自检 — 做完一步就检查，ffprobe+截帧+播放确认 |
| researcher | 任务太大就拆 — 单任务输出只开头就结束→拆成子课题并行 |
| news | 忠实原文 — 严禁改写/加工/意译新闻内容，snippet直接引用 |
| doctor | 医疗免责 — 不做诊断、不开药方、不替代专业医疗 |

注入格式：
```
[HARNESS 铁律] 以下规则优先级最高，每轮必须遵守:
1. 先查记忆再动手 — ...
2. 能修就修，不卡住 — ...（coder专属，替换"做完必交付"）
3. 安全红线不碰 — ...
...
```

## 当前生效的规则

| 规则 ID | 触发条件 | 适用角色 | 动作 | 超时行为 |
|---------|---------|---------|------|---------|
| context-overflow-warning | 上下文 > 70% | main, coder, researcher, media, news | requireApproval | 30秒超时后放行 |
| context-overflow-block | 上下文 > 90% | main, coder | block | 直接拒绝 |
| tool-burst-protection | 10分钟内 > 50次工具调用 | main | requireApproval | 15秒超时后放行 |
| long-session-check | 会话运行 > 60分钟 | main, coder, researcher | pass | 在 prompt 中注入提醒 |
| error-retry-limit | 错误次数 > 3 | main, coder, researcher | requireApproval | 30秒超时后拒绝 |

## 各 hook 的作用

- **before_tool_call** — 每次工具调用前评估规则，可以 block 或 requireApproval
- **message_sending** — 将紧急通知注入到发送给用户的消息中（前缀 `[HARNESS]`）
- **before_prompt_build** — 每轮强制注入铁律摘要 + 规则触发的上下文提醒
- **after_tool_call** — 工具调用出错时记录 errorCount，供规则评估使用

## 通知前缀

- `[CLAW-MONITOR]` — 原有的监控通知（告警、检查点、子代理状态）
- `[HARNESS]` — Harness 产生的通知（规则评估结果、上下文注入）
- `[HARNESS 铁律]` — 铁律强制注入

三个系统共存，互不干扰。

## 配置文件

| 文件 | 位置 | 作用 | 热加载 |
|------|------|------|--------|
| `harness-rules.json` | 与 index.js 同目录 | 规则配置（阈值、动作、角色） | 是（mtime 缓存） |
| `iron-laws.json` | 与 index.js 同目录 | 铁律内容（通用 + 角色专属） | 是（mtime 缓存） |

修改配置文件后无需重启 Gateway，下次 hook 触发时自动加载新内容。

## 如何使用

### 查看状态

让 agent 调用 `harness_status` 工具，查看当前规则配置和会话指标。

### 查看日志

让 agent 调用 `harness_log` 工具，查看最近的规则触发记录（哪个规则、什么动作、什么结果）。

### 自定义规则

编辑 `harness-rules.json`，修改阈值或添加新规则。

规则结构：
```json
{
  "id": "my-rule",
  "name": "My Rule",
  "agentRoles": ["main"],
  "hook": "before_tool_call",
  "trigger": { "contextUsage": { "gt": 50 } },
  "action": "block",
  "actionConfig": { "blockReason": "上下文超过50%，请委派子代理" },
  "enabled": true
}
```

触发条件支持的字段：`contextUsage`、`toolCallCount`、`toolCallCountInWindow`（需配合 `windowMinutes`）、`turnCount`、`sessionDurationMinutes`、`errorCount`

比较运算符：`gt`（大于）、`lt`（小于）、`gte`（大于等于）、`lte`（小于等于）、`eq`（等于）

多个条件之间是 AND 逻辑（全部满足才触发）。

### 自定义铁律

编辑 `iron-laws.json`，修改通用铁律或添加新的角色专属铁律。

```json
{
  "ironLaws": {
    "universal": ["铁律1", "铁律2", ...],
    "roles": {
      "coder": "角色专属铁律",
      "newrole": "新角色的专属铁律"
    }
  }
}
```

### 关闭 Harness

在 `openclaw.json` 中设置：
```json
{
  "plugins": {
    "claw-monitor": {
      "harnessEnabled": false
    }
  }
}
```

或把具体规则的 `enabled` 设为 `false`。

## requireApproval 在不同渠道的表现

### Agent 控制模式（默认启用）

当 `agentApproval: true`（默认）时，`requireApproval` 规则不再依赖 UI 审核流程，而是由主 agent（葱花）控制：

1. **触发时**：向主 agent 的 session 注入通知消息，包含规则名、描述、子 agent sessionKey、工具名和建议操作
2. **根据 `timeoutBehavior` 决定行为**：
   - `timeoutBehavior: "allow"` → **放行**（工具调用正常执行），主 agent 可事后 steer/kill 干预
   - `timeoutBehavior: "deny"` → **阻止**（工具调用被拒绝），主 agent 可通过发送 `HARNESS_ALLOW <ruleId>` 放行
3. **放行机制**：主 agent 向子 agent 发送 `HARNESS_ALLOW <ruleId>` 后，该规则对该 session 永久放行（内存 + 文件标记）

#### 放行操作

对于 `timeoutBehavior: "deny"` 的规则（如 error-retry-limit），主 agent 可以：

- **方式1**：`sessions_send(sessionKey="<子agent>", message="HARNESS_ALLOW error-retry-limit")`
- **方式2**：`subagent_steer(sessionKey="<子agent>", message="HARNESS_ALLOW error-retry-limit")`
- **方式3**：创建标记文件 `touch /tmp/harness-allow/<sessionKey>__<ruleId>`

#### 通知示例

```
[HARNESS] 规则触发: Error Retry Limit (error-retry-limit)
描述: 3 tool errors recorded. Possible retry loop — continue?
子Agent: agent:coder:subagent:xxx
工具: exec
超时行为: 拒绝
→ 如需放行: sessions_send(sessionKey="agent:coder:subagent:xxx", message="HARNESS_ALLOW error-retry-limit") 或 subagent_steer(sessionKey="agent:coder:subagent:xxx", message="HARNESS_ALLOW error-retry-limit") 或创建标记文件: mkdir -p /tmp/harness-allow && touch /tmp/harness-allow/agent_coder_subagent_xxx__error-retry-limit
```

#### 关闭 Agent 控制模式

在 `harness-rules.json` 中设置 `"agentApproval": false`，将回退到原始 UI 审核流程。

### 原始 UI 审核流程（agentApproval: false 时）

| 渠道 | 表现 |
|------|------|
| Control UI（Web 界面） | 显示确认按钮，用户可点击 allow/deny |
| CLI / Telegram / Discord 等 | 无交互界面，走超时机制 |
| 超时后 `timeoutBehavior: "allow"` | 自动放行（等于"记录但不阻止"） |
| 超时后 `timeoutBehavior: "deny"` | 自动拒绝 |

**结论：** Agent 控制模式下，`requireApproval` 在微信/CLI渠道不再等同于 block，而是由主 agent 实时决策。

## 数据来源

- 上下文使用率：从 `sessions.json` 的 `totalTokens` + `openclaw.json` 模型配置的 `contextWindow` 计算（不再硬编码 170K）
- 工具调用计数：Harness 自行维护的滑动时间窗口计数器
- 会话时长：从首次工具调用时间开始计算
- 错误计数：从 `after_tool_call` hook 中记录

## 文件清单

| 文件 | 作用 |
|------|------|
| `index.js` | Harness 函数和 hook 注册（与原有监控代码同文件） |
| `harness-rules.json` | 规则配置文件 |
| `iron-laws.json` | 铁律配置文件 |
| `openclaw.plugin.json` | 插件配置 schema（含 harness 相关属性） |
| `test-harness.js` | 集成测试脚本 |
