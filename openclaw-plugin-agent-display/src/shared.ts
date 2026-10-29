export const PLUGIN_ID = "agent-display";
export const PLUGIN_VERSION = "0.2.0";
export const DASHBOARD_ROUTE = "/plugins/agent-display/dashboard";
export const DASHBOARD_PAGE_ID = "agent-display";
export const DASHBOARD_PAGE_LABEL = "agent作战大屏";

export type DashboardMetricSnapshot = {
  agents: number;
  activeAgents: number;
  activeSessions: number;
  totalSessions: number;
  channelsOnline: number;
  channelsTotal: number;
  tokens: number;
  cost: number;
  cronJobs: number;
  models: number;
};

export type DashboardAgentSnapshot = {
  id: string;
  name: string;
  model?: string;
  sessions: number;
  active: boolean;
  status?: string;
  /** Department / team hint used by the HQ projection. */
  team?: string;
  /** Provider-reported usage attributed to this agent when available. */
  tokens?: number;
  cost?: number;
  lastActiveAt?: number;
};

export type DashboardChannelSnapshot = {
  id: string;
  label: string;
  running: boolean;
  connected: boolean;
  accountId?: string;
  lifecycle?: string;
  lastError?: string | null;
};

export type DashboardSessionStage =
  | "queued"
  | "running"
  | "review"
  | "done"
  | "failed";

export type DashboardSessionSnapshot = {
  key: string;
  agentId: string;
  title: string;
  updatedAt: number;
  active: boolean;
  lastMessage?: string;
  /** Normalized lifecycle. External connectors may set this directly. */
  stage?: DashboardSessionStage;
  /** 0..1 progress. Falls back to a stage-based estimate in the dashboard. */
  progress?: number;
  /** Source system: openclaw, jira, github, crm, … */
  source?: string;
  channel?: string;
  startedAt?: number;
  tokens?: number;
  cost?: number;
  error?: string;
};

export type DashboardEventSnapshot = {
  time: string;
  tag: string;
  text: string;
  /** Epoch milliseconds. The legacy string-only fields stay for older themes. */
  ts?: number;
  agentId?: string;
  sessionKey?: string;
  kind?: string;
  source?: string;
};

export type DashboardWorkItemSnapshot = {
  id: string;
  title: string;
  /** Source system: openclaw, jira, github, crm, … */
  source: string;
  stage: DashboardSessionStage;
  progress: number;
  status?: string;
  owner?: string;
  agentId?: string;
  sessionKey?: string;
  priority?: string;
  createdAt?: number;
  updatedAt?: number;
  url?: string;
};

export type DashboardSnapshot = {
  updatedAt: number;
  gateway: {
    ok: boolean;
    version?: string;
  };
  summary: string;
  metrics: DashboardMetricSnapshot;
  agents: DashboardAgentSnapshot[];
  channels: DashboardChannelSnapshot[];
  sessions: DashboardSessionSnapshot[];
  workItems: DashboardWorkItemSnapshot[];
  events: DashboardEventSnapshot[];
  errors: string[];
};

export function emptySnapshot(): DashboardSnapshot {
  return {
    updatedAt: 0,
    gateway: { ok: false },
    summary: "",
    metrics: {
      agents: 0,
      activeAgents: 0,
      activeSessions: 0,
      totalSessions: 0,
      channelsOnline: 0,
      channelsTotal: 0,
      tokens: 0,
      cost: 0,
      cronJobs: 0,
      models: 0,
    },
    agents: [],
    channels: [],
    sessions: [],
    workItems: [],
    events: [],
    errors: [],
  };
}
