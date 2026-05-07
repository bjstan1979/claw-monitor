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

## 当前生效的规则

| 规则 ID | 触发条件 | 适用角色 | 动作 | 超时行为 |
|---------|---------|---------|------|---------|
| context-overflow-warning | 上下文 > 70% | main, coder, researcher, media, news | requireApproval | 30秒超时后放行 |
| context-overflow-block | 上下文 > 90% | main, coder | block | 直接拒绝 |
| tool-burst-protection | 10分钟内 > 50次工具调用 | main | requireApproval | 15秒超时后放行 |
| long-session-check | 会话运行 > 60分钟 | main, coder, researcher | pass | 在 prompt 中注入提醒 |

## 各 hook 的作用

- **before_tool_call** — 每次工具调用前评估规则，可以 block 或 requireApproval
- **message_sending** — 将紧急通知注入到发送给用户的消息中（前缀 `[HARNESS]`）
- **before_prompt_build** — 在构建 prompt 时注入规则提醒（如长时间会话建议保存进度）
- **after_tool_call** — 工具调用出错时记录 errorCount，供规则评估使用

## 通知前缀

- `[CLAW-MONITOR]` — 原有的监控通知（告警、检查点、子代理状态）
- `[HARNESS]` — Harness 产生的通知（规则评估结果、上下文注入）

两个系统共存，互不干扰。

## 如何使用

### 查看状态

让 agent 调用 `harness_status` 工具，查看当前规则配置和会话指标。

### 查看日志

让 agent 调用 `harness_log` 工具，查看最近的规则触发记录（哪个规则、什么动作、什么结果）。

### 自定义规则

编辑 `harness-rules.json`（与 index.js 同目录），修改阈值或添加新规则。文件修改后自动重新加载（无需重启 Gateway）。

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

| 渠道 | 表现 |
|------|------|
| Control UI（Web 界面） | 显示确认按钮，用户可点击 allow/deny |
| CLI / Telegram / Discord 等 | 无交互界面，走超时机制 |
| 超时后 `timeoutBehavior: "allow"` | 自动放行（等于"记录但不阻止"） |
| 超时后 `timeoutBehavior: "deny"` | 自动拒绝 |

**结论：** 在非 Web 界面下，`requireApproval` 等于"记录事件 + 超时后按配置放行或拒绝"。真正有即时效果的是 `block`（直接拒绝）和 `pass`（注入提醒）。

## 数据来源

- 上下文使用率：从 sessions.json 的 totalTokens 估算，或从 JSONL 文件大小估算
- 工具调用计数：Harness 自行维护的滑动时间窗口计数器
- 会话时长：从首次工具调用时间开始计算
- 错误计数：从 after_tool_call hook 中记录

## 文件清单

| 文件 | 作用 |
|------|------|
| `index.js` | Harness 函数和 hook 注册（与原有监控代码同文件） |
| `harness-rules.json` | 规则配置文件 |
| `openclaw.plugin.json` | 插件配置 schema（含 harness 相关属性） |
| `test-harness.js` | 集成测试脚本 |