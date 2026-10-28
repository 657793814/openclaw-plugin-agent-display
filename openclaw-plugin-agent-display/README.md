# agent作战大屏 · OpenClaw Plugin

把仓库根目录的 `index.html`（8 套主题的 Agent 战术大屏）接入 OpenClaw Control UI，并把主题核心数据绑定到真实 agents、sessions、channels、jobs、cases。原始大屏文件不做改动；构建时读取并生成插件内的副本。

## 快速开始

```sh
cd openclaw-plugin-agent-display
npm install
npm run build
npm run validate
openclaw plugins install . --force
```

本地路径安装会触发信任提示；确认代码来源后使用 `--force`。

开启原生插件 UI：

```json5
{
  gateway: {
    controlUi: {
      experimental: { customPlugins: true },
    },
  },
}
```

或 Control UI：**Settings → Labs → Custom plugin UI**。然后刷新浏览器，在侧边栏打开 **agent作战大屏**。

## 实现方式

- **Feature Plugin**：注册原生 Control UI 页面与侧边栏入口。
- **Gateway HTTP Route**：`/plugins/agent-display/dashboard` 直接返回内嵌的大屏 HTML，避免 Control UI 的严格 CSP 拦截内联脚本。路由使用 `auth: "plugin"` + 进程内签名 URL，URL 只由已登录的 `info` RPC 签发。
- **同源 iframe**：页面用 iframe 承载大屏，通过 `postMessage` 接收真实数据。
- **实时数据适配层**：`host.request` + `host.onEvent` + `host.subscribe` 聚合 agents、sessions、channels、usage、cron、models 和实时消息。
- **主题真实数据绑定**：`scripts/theme-data.js` 在 8 套主题挂载前合并真实快照；真实 agent 优先占位，多余槽位显示待命，保留 Forge/Works 的 AGI 索引兼容。
- **大屏内实时浮层**：右下角 `OPENCLAW LIVE` 胶囊，显示真实指标、Agent 状态和事件流；首条数据到达时自动展开 5 秒。

完整方案、数据映射、限制和后续计划见 [docs/INTEGRATION.md](./docs/INTEGRATION.md)。

## 目录

```text
openclaw-plugin-agent-display/
├── scripts/
│   ├── embed-dashboard.mjs      # 读取 ../index.html，注入 theme-data/浮层，生成 TS 字符串
│   ├── theme-data.js            # 8 套主题的真实数据合并层
│   ├── dashboard-bridge.css     # 大屏内浮层样式
│   └── dashboard-bridge.js      # 大屏内浮层逻辑与 postMessage 接收器
├── src/
│   ├── index.ts                 # 后端：注册 Gateway HTTP 路由
│   ├── control-ui.ts            # 前端：页面、iframe、数据适配与轮询
│   ├── contract.ts              # Feature contract（info 查询）
│   ├── shared.ts                # 共享常量与快照类型
│   ├── control-ui.css           # 页面容器样式
│   └── generated/               # 构建生成，不手改
├── docs/INTEGRATION.md
└── openclaw.plugin.json
```

## 注意

- Native UI 运行受信任 JavaScript，拥有当前操作员的 Gateway 权限；只安装可信插件。
- 大屏路由使用 `auth: "plugin"` + 签名 token；token 由已登录 Control UI 的 `info` RPC 获取，只用于加载静态 HTML，不授予 Gateway RPC 权限。
- 浮层显示聚合数据，不展示密钥、token 或完整对话内容。
- 原 `index.html` 保持不变；`src/generated/dashboard-html.ts` 由 `npm run embed` 生成。
