# agent作战大屏 · 系统设计

> 版本：插件 `0.2.0` · 2026-10-29
> 相关文档：[接入方案](./INTEGRATION.md) · [使用手册](../../使用手册.md)

## 1. 目标与边界

### 1.1 目标

把 `index.html` 里的 10 套大屏主题接入真实运行数据，并且**不改变任何主题的视觉设计**：

- 3D 场景、镜头、昼夜、粒子、机器人动作、部门走位全部保持原样。
- 真实数据只覆盖"读得懂的业务层"：KPI 数字、Agent 名称、会话/工单标题、事件流、终端日志、部门统计。
- 同一套数据接口同时服务 PARK（园区）与 HQ（总部），并预留 Jira / GitHub / CRM 等外部系统。

### 1.2 关键约束

| 约束 | 影响 |
| --- | --- |
| 原 `index.html` 只读 | 所有接入逻辑通过构建期注入，不手改主题源码 |
| 主题是"生成式动画"，没有数据层 | 不能直接替换模拟循环，否则场景会停、动作会断 |
| 内联脚本被 Control UI CSP 拒绝 | 大屏必须走 Gateway 路由 + 同源 iframe |
| 只有 OpenClaw 运行时可用 | 现阶段 `source` 只有 `openclaw`，外部连接器只定义接口 |
| Agent 级 token / cost 无数据 | 只展示总用量，不按 Agent 拆分金额 |

### 1.3 非目标

- 不做主题重设计、不改配色/排版/动效节奏。
- 不做完整 BI 查询层（不提供任意维度聚合、SQL、导出）。
- 不把大屏做成写操作入口（所有交互仍是本地视觉交互）。

---

## 2. 总体架构

```text
┌──────────────────────────── 数据源层 ────────────────────────────┐
│ OpenClaw Gateway RPC            （当前唯一在线数据源）            │
│   health / status / channels.status / sessions.list              │
│   agents.list / usage.cost / cron.list / models.list             │
│   session.message 事件流                                          │
│                                                                  │
│ 外部连接器（规划，接口已固定）                                    │
│   Jira · GitHub · Linear · CRM · 内部工单                         │
└───────────────────────────┬──────────────────────────────────────┘
                            │ collect
┌───────────────────────────▼──────────────────────────────────────┐
│ 归一化层  src/control-ui.ts                                       │
│   采集 → 清洗 → 裁剪 → DashboardSnapshot                          │
│   派生：stage / progress / source / workItems / lastActiveAt      │
└───────────────────────────┬──────────────────────────────────────┘
                            │ postMessage（同源 iframe）
┌───────────────────────────▼──────────────────────────────────────┐
│ 投影层  scripts/theme-data.js                                     │
│   projectPark(snapshot) → 车间/渠道/事件/KPI                      │
│   projectHQ(snapshot)   → 部门/成员/项目/事件/KPI                 │
└───────────────────────────┬──────────────────────────────────────┘
                            │ host.__dqApply / __dqPaint
┌───────────────────────────▼──────────────────────────────────────┐
│ 渲染层  index.html 主题                                            │
│   3D 模拟循环继续跑（视觉连续）                                    │
│   实时数据覆盖 KPI / 名牌 / 任务池 / 事件流 / 终端                 │
└──────────────────────────────────────────────────────────────────┘
```

四层职责清晰：**采集不关心主题，投影不关心 DOM，主题不知道数据从哪来。**

---

## 3. 数据源与连接器

### 3.1 OpenClaw（已接入）

| 数据 | RPC | 用途 |
| --- | --- | --- |
| 网关健康 | `health` | `gateway.ok` / 版本 |
| 运行时统计 | `status` | session 计数兜底 |
| Agent 列表 | `agents.list` | 名称、模型、状态、部门猜测 |
| 会话列表 | `sessions.list` | 标题、更新时间、活跃状态、来源渠道 |
| 活跃会话 | `sessions.list { activeOnly: true, limit: 1 }` | 运行中数量 |
| 渠道 | `channels.status { probe: false }` | 在线渠道数、错误 |
| 用量 | `usage.cost { agentScope: "all" }` | 总 token、总费用 |
| 定时任务 | `cron.list` | 任务数 |
| 模型 | `models.list` | 模型数 |
| 消息事件 | `session.message` | 事件流 |

采集参数见 [INTEGRATION.md §4](./INTEGRATION.md#4-数据映射)。

### 3.2 外部连接器（接口先行）

外部系统只要产出**同构的 `sessions[]` / `workItems[]`**，主题侧无需改动。约定：

```jsonc
{
  "id": "PROJ-142",
  "title": "结算页性能优化",
  "source": "jira",
  "stage": "running",          // queued | running | review | done | failed
  "progress": 0.62,            // 0..1
  "status": "In Progress",     // 原始状态，原样展示
  "owner": "阿前",
  "agentId": "frontend",       // 可关联到 OpenClaw Agent
  "sessionKey": "agent:frontend:main",
  "priority": "P1",
  "updatedAt": 1793251200000,
  "url": "https://jira.example.com/browse/PROJ-142"
}
```

接入规则：

1. **主键**：`source + ":" + id`，跨系统不冲突。
2. **合并**：同一主键以 `updatedAt` 较新的为准；`openclaw` 与外部系统用 `sessionKey` 关联。
3. **降级**：连接器超时/报错只记录到 `snapshot.errors`，不影响其他数据源，大屏继续显示上一份可用数据。
4. **阶段映射**：连接器负责把私有状态映射到 5 个标准 `stage`，不把状态判断塞进主题。
5. **进度缺失**：`progress` 为空时按 `stage` 给默认值（queued 8% / running 55% / review 80% / done 100% / failed 35%）。

规划中的连接器形态（三选一，按部署环境定）：

| 形态 | 适用 | 说明 |
| --- | --- | --- |
| Gateway 插件内轮询 | 内网、凭证集中 | 连接器跑在 Gateway 进程内，复用插件生命周期 |
| 独立 sidecar + HTTP | 需要隔离凭证/网络 | 只监听 loopback，插件读 `/work-items` |
| Webhook 推送 | Jira/GitHub 原生支持 | 事件落到本地队列，快照读取队列 |

---

## 4. 归一化数据模型

`src/shared.ts` 定义的 `DashboardSnapshot` 是唯一的系统间契约。

```ts
type DashboardSnapshot = {
  updatedAt: number;
  gateway: { ok: boolean; version?: string };
  summary: string;
  metrics: { agents, activeAgents, activeSessions, totalSessions,
             channelsOnline, channelsTotal, tokens, cost, cronJobs, models };
  agents: DashboardAgentSnapshot[];
  channels: DashboardChannelSnapshot[];
  sessions: DashboardSessionSnapshot[];
  workItems: DashboardWorkItemSnapshot[];
  events: DashboardEventSnapshot[];
  errors: string[];
};
```

### 4.1 关键字段

| 字段 | 位置 | 说明 |
| --- | --- | --- |
| `stage` | session / workItem | 统一生命周期，主题只认这 5 个值 |
| `progress` | session / workItem | 0..1，缺失时按 stage 推导 |
| `source` | session / workItem / event | `openclaw` / `jira` / `github` / `crm` … |
| `sessionKey` | workItem / event | 回连 OpenClaw 会话，用于把外部工作项落到具体 Agent |
| `agentId` / `lastActiveAt` | agent | 用于部门归属与"最近活跃" |
| `ts` | event | epoch ms，便于排序与去重 |
| `url` | workItem | 外部系统深链（当前主题未渲染，留给后续） |

### 4.2 派生规则（`control-ui.ts`）

```text
stage(session):
  1. 显式 status ∈ {queued,running,review,done,failed} → 直接用
  2. 有 activeRun / activeRunIds                      → running
  3. updatedAt 距今 < 10 分钟                          → review
  4. 其余                                             → done

progress(stage):
  queued 0.08 · running 0.55 · review 0.80 · done 1.00 · failed 0.35
```

`workItems` 当前由 session 一对一投影生成，字段与 session 对齐；接入外部系统后，它是外部工作项与内部会话的**联合视图**，主题不需要区分来源。

### 4.3 指标归一化（`theme-data.js#metricsOf`）

所有指标都做"快照优先、缺失回退到明细"的处理，保证某个 RPC 失败时大屏不出现 0 值假象：

- `totalSessions` 缺失 → 用 `sessions.length`
- `activeSessions` 缺失 → 用 `sessions.filter(active).length`
- `channelsOnline` 缺失 → 用 `running || connected` 计数
- `successRate` = 100 − 错误率；`errors` = `snapshot.errors.length + failed sessions`
- `recentAgeMin` = 最近一次会话更新的年龄（分钟），**不用平均值**——历史会话可能很旧，平均值会长期失真

---

## 5. 主题映射

### 5.1 设计原则：双轨制

主题的 3D 循环是"视觉发动机"，数据是"仪表盘"。因此：

```text
仿真循环（60fps）        真实数据（5Hz 覆盖）
├── 机器臂/传送带运动      ├── KPI 数字
├── 相机/昼夜/粒子        ├── Agent 名牌与角色
├── 事件气泡的节奏        ├── 任务/会话标题池
└── 工单在车间之间流动    └── 事件流与终端日志
```

实现方式（每个主题两个钩子）：

| 钩子 | 触发 | 作用 |
| --- | --- | --- |
| `host.__dqApply(snapshot)` | 快照到达 | 写数据源、替换名称/标题池、灌入真实事件（去重） |
| `host.__dqPaint()` | 原生 `updatePanels()` 之后 | 覆盖 KPI、部门行、底部统计 |

`updatePanels` 被包装为"先跑原生，再跑实时覆盖"，两者同频（约 5Hz），避免节流造成数字来回跳。

### 5.2 PARK 智造园区

主题语义是"6 座车间 = 6 条 Agent 工作流"。

| 主题元素 | 真实数据 | 实现 |
| --- | --- | --- |
| 6 座车间负责人 `w.ag` | 前 6 个 Agent | 名称替换，车间语义与工序链保持不变 |
| 车间任务池 `w.titles` | 该 Agent 的 session 标题，不足用全局最新补 | `projectPark().workshops[k].titles` |
| 渠道 `CH[6]` | 在线渠道名，不足保留原值 | 只替换前 N 个 |
| 事件流 `LOG` | `snapshot.events` | 按 `key` 去重，最多追加 6 条/次 |
| 车间终端 | 事件按 `agentIndex` 落到对应车间 | `tPush(k, "hd2", text)` |
| 车间状态（列表行 + 3D 标签） | `agent.active` → 运行中 / 待命 | 会话数替换原有百分比 |
| KPI 卡 | 活跃会话 / 累计会话 / 运行中 / 渠道在线率 / 最近会话 / 在线 Agent | 直接写 `pOrd`…`pRej` |
| 底栏 | 今日交付→累计会话、在制→活跃、一次通过率→成功率 | `sbDel` / `sbWip` / `sbFpy` |

KPI 文案随语义调整（"今日工单"→"活跃会话"），数值不允许用模拟值。

### 5.3 HQ 智能总部

主题语义是"8 个部门 + Chief + 项目流水线"。

| 主题元素 | 真实数据 | 说明 |
| --- | --- | --- |
| Chief | 第一个 Agent | 名字与角色覆盖，保留"点 Chief 派任务"交互 |
| 部门成员名牌 | 其余 Agent | 按 `deptOfAgent()` 关键词规则分配到 8 个部门，槽位不足则顺序填充 |
| 项目 | 最近 8 个 session | `mkProject({ live: true })` 重建，`progress` 决定停在哪一阶段 |
| 部门统计行 | 部门成员数 / 会话 / 完成数 / 进度 | 进度 = 完成会话 / 总会话 |
| 底部 KPI | 累计完成 / 运行中 / 最近更新 / 最近会话 / 错误率 / 累计 Token | 覆盖率 100% |
| 顶部"人在忙 / 项目推进中" | Agent 总数 / 未完成项目数 | 文案同步调整 |
| 事件流 | `snapshot.events` | 按部门着色 |

`deptOfAgent()` 的规则顺序：设计 → 市场 → 运营 → 研发 → 人事 → 财务 → 法务行政 → 产品，命中关键词即归属；都不命中时按 id 字符和取模，保证稳定分布。

### 5.4 `live` 项目标记

`mkProject({ live: true })` 的项目：

- **不自动进入下一期**（原生 `preset` 项目 24 秒后 `nextPhase`）。
- **不自动删除**（原生用户项目 90 秒后归档移除）。
- 只在下一次快照指纹变化时整体重建。

因此真实会话列表变化不会把项目"演"没了。

### 5.5 其余 8 套主题

OPS / SPIDER / NEURAL / FACTORY / NEBULA / FORGE / WORKS / ION 仍走 `theme-data.js` 的 `__DQ_MERGE_*` 合并（agent 槽位、工作流、渠道、任务/用例）。这些主题的合并发生在**数据声明处**，PARK / HQ 则发生在**渲染钩子处**，后者才能保住 3D 循环。

### 5.6 真实度矩阵与刷新时机

“接入了真实数据”并不等于“整块屏都是实时的”。当前实现的真实度是分层的：

| 维度 | 主题 01–08 | 主题 09–10（PARK / HQ） |
| --- | --- | --- |
| Agent 名称、模型、在线状态、session 数 | 真实 | 真实 |
| 会话标题 / 工单 / 用例 / 渠道 | 真实（session 标题填进任务池） | 真实 |
| KPI 数字（交付量、节拍、进度、丝长…） | **模拟** | 真实 |
| 3D 动作、工单流动、粒子、镜头、昼夜 | 模拟 | 模拟（刻意保留） |
| 主题内事件流 / 终端日志 | 模拟 | 真实（接入后关闭合成日志） |
| 数据刷新时机 | **仅在挂载时合并** | **每次快照都覆盖（约 5Hz）** |
| 接入机制 | 构建期包装数据声明 `__DQ_MERGE_*` | 运行时投影钩子 `__dqApply` / `__dqPaint` |

两种机制的分工：

- **01–08 是“替换实体、保留演出”**。`embed-dashboard.mjs` 把主题里的 `AGENTS` / `WF` / `CH` / `PROJECTS` / `JOBS` / `CASES` 声明包成 `__DQ_MERGE_*(原始值, 主题)`，在主题挂载那一刻用真实快照替换实体。动画、计数、进度仍由主题本地模拟驱动，因此数字会继续“演”。
- **09–10 是“叠加业务层”**。3D 循环原样运行，`__dqPaint()` 在原生 `updatePanels()` 之后覆盖 KPI、名牌、状态、任务池和部门统计，所以数字与实体都是真实值。

刷新时机的差异是**有意的**：

- `boot()` 只在首次加载时挂载一次（`booted` 标记）。切换主题时才会重新挂载并重新合并快照。
- 对 01–08 调用 `__DQ_APPLY__()` 只更新快照变量和右下角 `OPENCLAW LIVE` 浮层，不会重绘主题本体。
- 若每次快照都强制重挂载 01–08，会每 3 秒重置一次动画状态，观感明显变差。因此当前选择“挂载时取数”。

带来的实际表现：

| 操作 | 01–08 | 09–10 |
| --- | --- | --- |
| Agent 上线 / 下线 | 不自动变化 | 自动变化 |
| session 标题变化 | 不自动变化 | 自动变化 |
| 切换主题后回来 | 取最新快照 | 取最新快照 |
| 刷新 iframe | 取最新快照 | 取最新快照 |
| 右下角浮层指标 | 始终实时 | 始终实时 |

后续若要让 01–08 也持续刷新，正确做法是**逐主题增加增量刷新钩子**（更新已有 DOM 文本/卡片数据，不重挂载），而不是定时重挂载。

### 5.7 实时浮层（OPENCLAW LIVE）

浮层是唯一在 10 套主题里行为一致的实时组件：

- 右下角胶囊，首条快照到达时自动展开 5 秒，之后折叠。
- **可拖动**：按住胶囊或面板标题栏移动；位置写入 `localStorage`（`agent-display:dq-live-position`），刷新后保留。
- **自动避让**：展开时根据胶囊位置自动选择向上或向下展开，并限制面板高度，避免超出视口；靠近左侧时改为左对齐。
- **微调**：胶囊获得焦点后 `Shift + 方向键` 移动 12px，`Shift + Alt + 方向键` 移动 48px。
- **复位**：面板右上角 `↺` 按钮清除自定义位置，回到右下角默认位置。

---

## 6. 实时链路

```text
Control UI 页面
  ├─ 3s 轮询 collectSnapshot()
  ├─ session.message 事件 → 250ms 防抖合并刷新
  └─ host.subscribe 事件 → 同上
        │
        ▼ postMessage({ type: "agent-display:snapshot", snapshot })
   iframe bridge
        ├─ __DQ_SET_SNAPSHOT__(snapshot)
        ├─ __DQ_APPLY__(snapshot)
        │     └─ host.__dqApply(snapshot)   // 仅 PARK/HQ 定义此钩子
        └─ 刷新手写浮层（指标/事件）
        │
        ▼ 主题内 60fps 循环（不变）
   updatePanels() → 原生面板 → __dqPaint() 覆盖真实值
```

时序要点：

1. iframe 加载完成 → bridge 发 `agent-display:ready` → 父页面立即推一份快照，首屏不空白。
2. `__DQ_APPLY__` 先写快照，再调用**当前可见主题**的 `__dqApply`（只有 PARK / HQ 定义），避免 10 个主题同时重算。
3. 01–08 没有运行时刷新钩子：`__DQ_APPLY__` 对它们只更新快照和浮层，主题本体在下次挂载（切换主题 / 刷新 iframe）时才重新合并。
4. `boot()` 带 `booted` 标记，只在首次加载时挂载，不会被每次快照重复调用。
5. 事件去重使用 `key = ts|tag|text`，窗口上限 400 条，超出后保留最近 20 条重开窗口。
6. 首次接入实时数据时清空主题的本地 `LOG`，之后模拟日志被 `log` 包装器屏蔽，**只保留真实事件**。
7. 切换主题时重新 `mount`，启动时读 `__DQ_GET_SNAPSHOT__()` 立即回填，不等下一次轮询。
8. 浮层位置恢复发生在 bridge 初始化时，早于第一条快照；拖动/复位不会触发主题重绘。

---

## 7. 安全模型

| 面 | 措施 |
| --- | --- |
| 路由鉴权 | `auth: "plugin"` + 进程内 HMAC 签名 token，仅 `info` RPC 签发 |
| 嵌入限制 | `X-Frame-Options: SAMEORIGIN` + CSP `frame-ancestors 'self'` |
| Token 泄露 | `Referrer-Policy: no-referrer`，token 只用于加载静态 HTML |
| CSP 隔离 | 大屏路由单独放宽（内联脚本、jsDelivr、Google Fonts），不影响 Control UI |
| 数据最小化 | 只传聚合指标、名称、标题、时间、事件摘要；不传 API Key、完整对话、文件内容 |
| 信任边界 | Native UI 拥有当前操作员权限，插件必须来自可信来源 |

---

## 8. 可观测性与失败处理

| 场景 | 表现 | 处理 |
| --- | --- | --- |
| 某个 RPC 失败 | `errors[]` 增加，指标回退到明细 | 大屏继续渲染，浮层底部显示非致命错误 |
| 快照为空/未到达 | 主题按原生模拟数据运行 | 顶栏仍显示"示例数据"，不会出现空面板 |
| iframe token 过期 | 403 | 重新进入页面，由 `info` RPC 重新签发 |
| WebGL 不可用 | 主题显示回退提示 | 面板数据仍可用 |
| 投影异常 | 单帧 `try/catch` | 错误写入 `host.__dqState().err`，不影响主循环 |
| 数据暴涨 | `sessions` 截断 24 条、`events` 12 条、去重窗口 400 | 快照大小可控（< 50KB） |

自检接口（Playwright / 控制台）：

```js
document.getElementById('host-park').__dqState()
// { live: true, seen: 8, snapAt: 1793251790546, err: null }

document.getElementById('host-hq').__dqState()
// { live: true, projects: 8, seen: 8, snapAt: ..., err: null }
```

---

## 9. 性能

- 快照：7 Agent / 21 Session 量级，JSON < 20KB，3 秒一次，可忽略。
- 投影：`projectPark` / `projectHQ` 都是 O(agents + sessions)，每个面板周期（约 200ms）一次，实测无卡顿。
- 渲染：实时覆盖只改文本节点和 `style.width/height`，不触碰 WebGL 缓冲。
- 主题切换：只挂载当前主题；Three.js 主题按需从 CDN 加载。

扩展性上限（经验值）：数百个 Agent、数千个 Session 时建议：

1. 快照增量化（只传 diff，按 `updatedAt` 游标）。
2. 投影缓存（主题侧按 `snapshot.updatedAt` 记忆化）。
3. 事件改为 WebSocket/SSE 推送，去掉轮询。

---

## 10. 演进路线

### 已完成

- 统一快照契约 + `stage` / `progress` / `source` / `workItems`。
- PARK、HQ 实时覆盖（KPI、名牌、任务池、事件、终端、部门统计）。
- 双轨制渲染：3D 模拟不停，真实数据覆盖业务层。
- `live` 项目标记，真实会话不会被模拟逻辑回收。
- 实时事件去重、首屏回填、主题切换回填。
- 浮层可拖动、位置记忆、自动避让、复位与键盘微调。
- 明确“真实实体 + 模拟指标”的分层，并文档化两套刷新时机。

### 下一步

1. **01–08 增量刷新**：为 8 套主题补不重挂载的 DOM 更新钩子，让 Agent 上下线、session 数变化能持续反映。
2. **外部连接器**：Jira / GitHub / CRM → `workItems`，先只读。
3. **字段补全**：`agents[].tokens/cost` 待 Gateway 提供 Agent 级用量后填入。
4. **推送化**：SSE 替代 3 秒轮询，事件延迟从秒级降到百毫秒。
5. **筛选**：按 Agent / 渠道 / 时间范围过滤快照，主题侧零改动。
6. **主题覆盖度**：把 `workItems.url` 接成点击深链；给 PARK 车间加"来源"角标。

### 已知限制

- Agent 级 token / cost 无数据，只展示总量。
- 历史会话时间很旧，"最近会话"用最小值而非平均值，避免误导。
- 部分 Session 没有 `derivedTitle`，标题会退化到 session key。
- Three.js 与字体仍依赖 CDN，离线部署需本地化。
