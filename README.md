# dsh-haloring-status

**DSH HaloRing 状态桥** — 把 DSH 的实时运行状态与回合进度写成一个轻量状态文件，供托盘指示灯、状态栏、桌面小组件等外部程序读取。

只观察宿主公开的会话事件与 Agent 状态，**不读取聊天正文**，也不修改会话。

- **Host-only**：没有页面、没有工具、没有客户端注入，不改变 DSH 原有界面
- **零配置**：装上即用，无需 token、无需端口、无需认证
- **跨进程友好**：输出是纯文本 `key=value`，任何语言都能解析

最终结果落成一个文件。外部程序只需**读一个本地文本文件**：

```text
%USERPROFILE%\.dsh\dsh-status.txt
```

无需认证、无需重连、DSH 重启自动恢复。

---

## 输出格式

```ini
version=1
state=running
priority=2
updated=1793210745187
pid=12716
detail=Agent 运行中（turn 35）
progress=44
attention=0
approvals=0
turns=1
sessions=1
completed=0
degraded=0
error=0
```

| 字段 | 含义 |
|---|---|
| `state` | `idle` / `running` / `attention` / `degraded` / `error` / `completed` / `offline` |
| `priority` | 数值优先级，越大越优先（`-1` 离线 ~ `5` 故障）|
| `updated` | Unix **毫秒**时间戳。读取方据此判断心跳 |
| `pid` | 宿主进程 ID，用于识别 DSH 是否重启 |
| `detail` | 人类可读描述，可直接显示在 tooltip |
| `progress` | `0..100` 整数，**非精确百分比**，仅作"正在推进"的提示 |
| `attention` / `approvals` | 待处理审批数量 |
| `turns` / `sessions` | 活动回合数 / 存活会话数 |
| `completed` / `degraded` / `error` | 对应状态的布尔标志（`0`/`1`）|

写入频率：**250ms ~ 1s**（状态变化时立即写，静止时 1 秒心跳）。
DSH 退出后文件停止更新，读取方按心跳超时（建议 8 秒）判为离线。

---

## 状态判定

多个状态可能同时成立，插件按**固定优先级**取一个输出，而不是"最后事件优先"：

```text
故障（error/blocked） > 降级（Provider 重试/上下文压缩）>
等待授权/审批 > 运行中 > 回合完成 > 空闲
```

### 事件映射

| 事件 | 输出状态 |
|---|---|
| `turn/start` | `running` |
| `approval/asked`（未决定）| `attention` |
| `approval/decided` | 清除等待，回到之前状态 |
| `llm/retry` / `llm/retry-started` | `degraded` |
| `assistant/attempt`（finish.reason = error）| `degraded` |
| `compaction/start` | `degraded` |
| `compaction/end` | 保持降级 1.5 秒后恢复 |
| `turn/end`（reason = completed）| `completed`（保持 1.8 秒）|
| `turn/end`（reason = error/blocked）| `error` |
| `turn/end`（reason = max-tokens）| `degraded`（10 秒）|
| `turn/end`（reason = aborted/interrupted）| 不算等待也不算错误 |
| 无活动会话且宿主在线 | `idle` |

---

## 进度算法

DSH 的 `step` 事件语义很清晰：**一次 `step` = 一次完整的「模型推理 → 产出工具调用 → 工具执行完毕」循环**。
`step` 序号天然就是"已经完成了几个思考-行动循环"的精确计数。

但**总步数未知**——第 3 步时不知道还要几步。所以这里刻意**不用线性分母**：

```
progress = 25 + 70 × (1 - e^(-已完成step数 / 3.2))  [+8 若正在执行工具]
上限 95，只有 turn/end 才到 100
```

用渐近曲线，长任务会持续缓慢爬升，而不是卡在某个数字不动。

| 已完成 step | 进度 | 工具执行中 |
|---|---|---|
| 0 | **25%** | 33% |
| 1 | 44% | 52% |
| 2 | 58% | 66% |
| 3 | 68% | 76% |
| 4 | 75% | 83% |
| 5 | 80% | 88% |
| 10 | 92% | 95% |

各状态下的进度取值：

| 状态 | progress |
|---|---|
| `running` | 25 → 95（按 step 推进）|
| `attention` | 25（冻结，表示卡住但没失败）|
| `degraded` | 50（冻结，表示有进展但不顺）|
| `completed` | 100 |
| `error` | 100 |
| `idle` | 0 |

起始值取 **25 而非 0**，让读取方一眼就能看出"在工作"，而不是分不清"刚启动"和"没动静"。

---

## 安装

```powershell
dsh plugin --profile desktop add github:DeeepMind/dsh-haloring-status
```
或本地安装：

```powershell
dsh plugin --profile desktop add "file:<路径>/dsh-haloring-status"
```

安装后**重启 DSH 一次**以加载宿主插件。

验证：

```powershell
Get-Content "$env:USERPROFILE\.dsh\dsh-status.txt"
```

应该看到内容且每秒更新。

### 卸载

```powershell
dsh plugin --profile <profile> remove dsh-haloring-status
```

---

## 已知限制

- **进度不精确**：总步数未知，只能给渐进提示，不承诺准确百分比
- **单文件单状态**：多个会话同时运行时，取"最高优先级 + 第一个活动会话"的合成结果，不区分会话
- **不响应审批**：本插件只观察，审批仍需你在 DSH 界面里处理
- **Windows 优先**：路径处理用 `os.homedir()`，理论上跨平台，但仅在 Windows 11 上验证过

---

## 相关项目

- **DshHaloRing** — Windows 11 托盘环形状态指示灯

## 许可证

GPL-3.0
