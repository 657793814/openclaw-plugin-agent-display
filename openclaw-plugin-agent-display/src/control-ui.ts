import {
  defineControlUiPlugin,
  type ControlUiHost,
} from "openclaw/plugin-sdk/control-ui";
import { createFeatureClient } from "openclaw/plugin-sdk/feature-contract";
import { contract } from "./contract.js";
import {
  DASHBOARD_PAGE_ID,
  DASHBOARD_PAGE_LABEL,
  DASHBOARD_ROUTE,
  PLUGIN_ID,
  type DashboardAgentSnapshot,
  type DashboardChannelSnapshot,
  type DashboardEventSnapshot,
  type DashboardSessionSnapshot,
  type DashboardSessionStage,
  type DashboardSnapshot,
  type DashboardWorkItemSnapshot,
} from "./shared.js";
import "./control-ui.css";

type RpcHealth = { ok?: boolean };

type RpcStatus = {
  runtimeVersion?: string;
  sessions?: {
    count?: number;
    byAgent?: Array<{ agentId: string; count: number }>;
  };
};

type RpcChannel = {
  running?: boolean;
  connected?: boolean;
  accountId?: string;
  lifecycle?: string;
  lastError?: string | null;
};

type RpcChannels = {
  channels?: Record<string, RpcChannel>;
  channelLabels?: Record<string, string>;
};

type RpcUsage = {
  daily?: Array<{ totalTokens?: number; totalCost?: number }>;
};

type RpcSession = {
  key: string;
  agentId: string;
  hasActiveRun?: boolean;
  activeRunIds?: string[];
  updatedAt?: number;
  lastActivityAt?: number;
  lastInteractionAt?: number;
  derivedTitle?: string | null;
  displayName?: string | null;
  label?: string | null;
  lastMessage?: string | null;
  lastMessagePreview?: string | null;
  channel?: string;
  status?: string;
  lastRunError?: string | null;
};

type RpcSessions = {
  sessions?: RpcSession[];
  totalCount?: number;
};

type RpcAgent = {
  id: string;
  name?: string;
  identity?: { name?: string };
  model?: { primary?: string };
  status?: string;
};

type RpcAgents = { agents?: RpcAgent[] };
type RpcCron = { jobs?: Array<{ id: string; name?: string; displayName?: string; enabled?: boolean }> };
type RpcModels = { models?: Array<{ id: string; available?: boolean }> };

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function textFrom(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textFrom).filter(Boolean).join(" ");
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return firstString(record.text, record.content, record.delta, record.message) ?? "";
  }
  return "";
}

function truncate(value: string, max: number): string {
  const text = value.replace(/\s+/gu, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function formatTime(ts: number | undefined): string {
  if (!ts || !Number.isFinite(ts)) return "--:--";
  return new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });
}

function compact(value: number): string {
  const n = Number.isFinite(value) ? value : 0;
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function isActiveSession(session: RpcSession): boolean {
  return session.hasActiveRun === true || (Array.isArray(session.activeRunIds) && session.activeRunIds.length > 0);
}

const SESSION_STATUSES = new Set([
  "queued",
  "running",
  "review",
  "done",
  "failed",
]);

function sessionStage(session: RpcSession, updatedAt: number): DashboardSessionStage {
  const status = String(session.status ?? "").toLowerCase();
  if (SESSION_STATUSES.has(status)) return status as DashboardSessionStage;
  if (isActiveSession(session)) return "running";
  const age = Date.now() - updatedAt;
  return age < 10 * 60_000 ? "review" : "done";
}

function sessionProgress(stage: DashboardSessionStage): number {
  switch (stage) {
    case "queued":
      return 0.08;
    case "running":
      return 0.55;
    case "review":
      return 0.8;
    case "done":
      return 1;
    case "failed":
      return 0.35;
    default:
      return 0.1;
  }
}

function describeSessionEvent(payload: unknown): DashboardEventSnapshot {
  const record = asRecord(payload);
  const session = asRecord(record.session);
  const message = asRecord(record.message);
  const sessionKey = firstString(record.sessionKey, record.key, session.key) ?? "";
  const directAgent = firstString(record.agentId);
  const derivedAgent = sessionKey.startsWith("agent:") ? sessionKey.split(":")[1] : undefined;
  const agentId = directAgent ?? derivedAgent ?? "";
  const text = truncate(
    textFrom(message.text ?? message.content ?? record.text ?? record.preview ?? record.summary) ||
      sessionKey ||
      "session.message",
    120,
  );

  return {
    time: formatTime(Date.now()),
    tag: "MSG",
    text: [agentId, text].filter(Boolean).join(" · "),
    ts: Date.now(),
    agentId: agentId || undefined,
    sessionKey: sessionKey || undefined,
    kind: "message",
    source: "openclaw",
  };
}

async function settle<T>(
  errors: string[],
  label: string,
  promise: Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    errors.push(`${label}: ${String(error)}`);
    return fallback;
  }
}

async function collectSnapshot(
  host: ControlUiHost,
  liveEvents: readonly DashboardEventSnapshot[],
): Promise<DashboardSnapshot> {
  const errors: string[] = [];
  const [health, status, channels, usage, sessionList, activeList, agentList, cron, models] =
    await Promise.all([
      settle(errors, "health", host.request<RpcHealth>("health"), {}),
      settle(errors, "status", host.request<RpcStatus>("status"), {}),
      settle(errors, "channels.status", host.request<RpcChannels>("channels.status"), {}),
      settle(errors, "usage.cost", host.request<RpcUsage>("usage.cost", { agentScope: "all" }), {}),
      settle(
        errors,
        "sessions.list",
        host.request<RpcSessions>("sessions.list", {
          limit: 200,
          archived: false,
          includeLastMessage: true,
          includeDerivedTitles: true,
          excludeSubagents: false,
          source: "dashboard",
        }),
        {},
      ),
      settle(
        errors,
        "sessions.list:active",
        host.request<RpcSessions>("sessions.list", {
          limit: 1,
          archived: false,
          activeOnly: true,
          source: "dashboard",
        }),
        {},
      ),
      settle(errors, "agents.list", host.request<RpcAgents>("agents.list"), {}),
      settle(errors, "cron.list", host.request<RpcCron>("cron.list"), {}),
      settle(errors, "models.list", host.request<RpcModels>("models.list"), {}),
    ]);

  const sessions = sessionList.sessions ?? [];
  const activeSessionCount = activeList.totalCount ?? sessions.filter(isActiveSession).length;
  const totalSessions = sessionList.totalCount ?? status.sessions?.count ?? sessions.length;

  const byAgent = new Map<string, number>();
  for (const row of status.sessions?.byAgent ?? []) {
    byAgent.set(row.agentId, row.count);
  }
  const loadedByAgent = new Map<string, number>();
  const activeByAgent = new Map<string, boolean>();
  const lastByAgent = new Map<string, number>();
  for (const session of sessions) {
    loadedByAgent.set(session.agentId, (loadedByAgent.get(session.agentId) ?? 0) + 1);
    if (isActiveSession(session)) activeByAgent.set(session.agentId, true);
    const updatedAt = session.updatedAt ?? 0;
    if (updatedAt > (lastByAgent.get(session.agentId) ?? 0)) {
      lastByAgent.set(session.agentId, updatedAt);
    }
  }

  const rawAgents =
    agentList.agents ??
    host.agents.rows.map((agent) => ({
      id: agent.id,
      name: agent.name,
      identity: agent.identity,
      model: agent.model,
      status: agent.status,
    }));

  const agentRows: DashboardAgentSnapshot[] = rawAgents.map((agent) => ({
    id: agent.id,
    name: agent.name ?? agent.identity?.name ?? agent.id,
    model: agent.model?.primary,
    sessions: byAgent.get(agent.id) ?? loadedByAgent.get(agent.id) ?? 0,
    active: activeByAgent.get(agent.id) === true,
    status: agent.status,
    lastActiveAt: lastByAgent.get(agent.id),
  }));

  const channelRows: DashboardChannelSnapshot[] = Object.entries(channels.channels ?? {}).map(
    ([id, channel]) => ({
      id,
      label: channels.channelLabels?.[id] ?? id,
      running: channel.running === true,
      connected: channel.connected === true,
      accountId: channel.accountId,
      lifecycle: channel.lifecycle,
      lastError: channel.lastError ?? null,
    }),
  );

  const tokens = (usage.daily ?? []).reduce((sum, day) => sum + (Number(day.totalTokens) || 0), 0);
  const cost = (usage.daily ?? []).reduce((sum, day) => sum + (Number(day.totalCost) || 0), 0);

  const sessionRows: DashboardSessionSnapshot[] = sessions
    .slice()
    .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
    .slice(0, 24)
    .map((session) => {
      const updatedAt = session.updatedAt ?? session.lastActivityAt ?? 0;
      const stage = sessionStage(session, updatedAt);
      return {
        key: session.key,
        agentId: session.agentId,
        title: session.derivedTitle ?? session.displayName ?? session.label ?? session.key,
        updatedAt,
        active: isActiveSession(session),
        lastMessage: session.lastMessage ?? session.lastMessagePreview ?? undefined,
        stage,
        progress: sessionProgress(stage),
        source: "openclaw",
        channel: session.channel,
        error: session.lastRunError ?? undefined,
      };
    });

  const sessionEvents: DashboardEventSnapshot[] = sessionRows.slice(0, 8).map((session) => ({
    time: formatTime(session.updatedAt),
    tag: session.active ? "RUN" : "SESS",
    text: `${session.agentId} · ${session.title}`,
    ts: session.updatedAt,
    agentId: session.agentId,
    sessionKey: session.key,
    kind: "session",
    source: "openclaw",
  }));

  const workItems: DashboardWorkItemSnapshot[] = sessionRows.map((session) => ({
    id: session.key,
    title: session.title,
    source: "openclaw",
    stage: session.stage ?? "done",
    progress: session.progress ?? 0,
    status: session.stage,
    owner: session.agentId,
    agentId: session.agentId,
    sessionKey: session.key,
    updatedAt: session.updatedAt,
  }));

  const events = [...liveEvents, ...sessionEvents].slice(0, 8);
  const channelsOnline = channelRows.filter((channel) => channel.running || channel.connected).length;
  const activeAgents = agentRows.filter((agent) => agent.active).length;

  return {
    updatedAt: Date.now(),
    gateway: {
      ok: health.ok === true,
      version: status.runtimeVersion,
    },
    summary: `${agentRows.length} agents · ${activeSessionCount} active · ${compact(tokens)} tok`,
    metrics: {
      agents: agentRows.length,
      activeAgents,
      activeSessions: activeSessionCount,
      totalSessions,
      channelsOnline,
      channelsTotal: channelRows.length,
      tokens,
      cost,
      cronJobs: cron.jobs?.length ?? 0,
      models: models.models?.length ?? 0,
    },
    agents: agentRows,
    channels: channelRows,
    sessions: sessionRows,
    workItems,
    events,
    errors: errors.slice(0, 4),
  };
}

export default defineControlUiPlugin({
  id: PLUGIN_ID,
  activate(host) {
    const feature = createFeatureClient(contract, host);

    host.ui.registerNavigation({
      id: DASHBOARD_PAGE_ID,
      label: DASHBOARD_PAGE_LABEL,
      page: { id: DASHBOARD_PAGE_ID },
      icon: "activity",
    });

    host.ui.registerPage({
      id: DASHBOARD_PAGE_ID,
      label: DASHBOARD_PAGE_LABEL,
      mount(container, context) {
        let disposed = false;
        let presented = context.presented;
        let frameReady = false;
        let latest: DashboardSnapshot | undefined;
        let pollTimer: number | undefined;
        let refreshTimer: number | undefined;
        let readyTimer: number | undefined;
        let inFlight = false;
        const liveEvents: DashboardEventSnapshot[] = [];

        const section = document.createElement("section");
        section.className = "agent-display-page";

        const frame = document.createElement("iframe");
        frame.className = "agent-display-frame";
        frame.title = DASHBOARD_PAGE_LABEL;
        frame.setAttribute("allow", "fullscreen");
        frame.referrerPolicy = "no-referrer";

        const loading = document.createElement("div");
        loading.className = "agent-display-status";
        loading.textContent = "正在加载agent作战大屏…";

        const error = document.createElement("div");
        error.className = "agent-display-status agent-display-error";
        error.hidden = true;
        const errorText = document.createElement("span");
        const retry = document.createElement("button");
        retry.type = "button";
        retry.textContent = "重试";
        error.append(errorText, retry);

        section.append(frame, loading, error);
        container.append(section);

        function targetOrigin(): string {
          return window.location.origin;
        }

        function send(snapshot: DashboardSnapshot): void {
          latest = snapshot;
          if (!frameReady || disposed) return;
          frame.contentWindow?.postMessage(
            { type: "agent-display:snapshot", snapshot },
            targetOrigin(),
          );
        }

        function showError(message: string): void {
          if (readyTimer !== undefined) {
            window.clearTimeout(readyTimer);
            readyTimer = undefined;
          }
          loading.hidden = true;
          error.hidden = false;
          errorText.textContent = message;
        }

        function armReadyTimer(): void {
          if (readyTimer !== undefined) window.clearTimeout(readyTimer);
          readyTimer = window.setTimeout(() => {
            if (disposed || frameReady) return;
            showError(
              `大屏加载超时（${DASHBOARD_ROUTE}）。请确认 Custom plugin UI 已开启，并检查 Gateway 日志。`,
            );
          }, 12_000);
        }

        function markReady(): void {
          if (disposed || frameReady) return;
          frameReady = true;
          if (readyTimer !== undefined) {
            window.clearTimeout(readyTimer);
            readyTimer = undefined;
          }
          loading.hidden = true;
          error.hidden = true;
          if (latest) send(latest);
          void refresh();
        }

        async function loadDashboard(): Promise<void> {
          if (disposed) return;
          frameReady = false;
          latest = undefined;
          error.hidden = true;
          loading.hidden = false;
          loading.textContent = "正在加载agent作战大屏…";
          armReadyTimer();
          try {
            const info = await feature.invoke("info", {});
            if (disposed) return;
            frame.src = new URL(info.dashboardUrl, window.location.origin).href;
          } catch (cause) {
            if (!disposed) showError(`大屏地址获取失败：${String(cause)}`);
          }
        }

        async function refresh(): Promise<void> {
          if (disposed || !presented || inFlight) return;
          inFlight = true;
          try {
            const snapshot = await collectSnapshot(context.host, liveEvents);
            if (disposed) return;
            send(snapshot);
            if (frameReady) error.hidden = true;
          } catch (cause) {
            if (disposed) return;
            showError(`实时数据获取失败：${String(cause)}`);
          } finally {
            inFlight = false;
          }
        }

        function queueRefresh(): void {
          if (disposed || !presented || refreshTimer !== undefined) return;
          refreshTimer = window.setTimeout(() => {
            refreshTimer = undefined;
            void refresh();
          }, 250);
        }

        function start(): void {
          if (disposed || pollTimer !== undefined) return;
          void refresh();
          pollTimer = window.setInterval(() => {
            void refresh();
          }, 3_000);
        }

        function stop(): void {
          if (pollTimer !== undefined) {
            window.clearInterval(pollTimer);
            pollTimer = undefined;
          }
        }

        function onMessage(event: MessageEvent): void {
          if (event.origin !== window.location.origin) return;
          if (event.source !== frame.contentWindow) return;
          const data = asRecord(event.data);
          if (data.type === "agent-display:ready") markReady();
        }

        function dispose(): void {
          if (disposed) return;
          disposed = true;
          stop();
          if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
          if (readyTimer !== undefined) window.clearTimeout(readyTimer);
          window.removeEventListener("message", onMessage);
          eventDisposer();
          subscribeDisposer();
          section.remove();
        }

        const onSessionMessage = (payload: unknown): void => {
          if (disposed) return;
          liveEvents.unshift(describeSessionEvent(payload));
          if (liveEvents.length > 24) liveEvents.length = 24;
          queueRefresh();
        };

        const eventDisposer = context.host.onEvent("session.message", onSessionMessage);
        const subscribeDisposer = context.host.subscribe(queueRefresh);
        window.addEventListener("message", onMessage);
        context.signal.addEventListener("abort", dispose, { once: true });

        retry.addEventListener("click", () => {
          if (!disposed) void loadDashboard();
        });

        void loadDashboard();
        if (presented) start();

        return {
          update(next) {
            presented = next.presented;
            if (presented) start();
            else stop();
          },
          dispose,
        };
      },
    });
  },
});
