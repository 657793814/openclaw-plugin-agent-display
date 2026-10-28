import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { defineFeaturePlugin } from "openclaw/plugin-sdk/feature-plugin";
import { contract, dashboardInfo } from "./contract.js";
import { dashboardHtml } from "./generated/dashboard-html.js";

const DASHBOARD_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' https://cdn.jsdelivr.net",
  "style-src 'unsafe-inline' https://fonts.googleapis.com",
  "font-src data: https://fonts.gstatic.com",
  "img-src data: blob:",
  "media-src data: blob:",
  "connect-src 'self' https:",
  "worker-src 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join("; ");

const DASHBOARD_TOKEN = createHmac("sha256", randomBytes(32))
  .update(`${contract.pluginId}:${dashboardInfo.route}`)
  .digest("base64url");

function createDashboardUrl(): string {
  const url = new URL(dashboardInfo.route, "http://localhost");
  url.searchParams.set("token", DASHBOARD_TOKEN);
  return `${url.pathname}${url.search}`;
}

function tokenMatches(candidate: string | null): boolean {
  if (!candidate) return false;
  const actual = Buffer.from(candidate);
  const expected = Buffer.from(DASHBOARD_TOKEN);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

type ResponseLike = {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(body?: string | Uint8Array): void;
};

function sendText(res: ResponseLike, statusCode: number, body: string): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(body);
}

export default defineFeaturePlugin({
  contract,
  name: "agent作战大屏",
  description: "OpenClaw-native Agent Display dashboard with real agents, sessions, channels, usage, cron, and live events.",
  setup(api) {
    api.registerHttpRoute({
      path: dashboardInfo.route,
      auth: "plugin",
      match: "exact",
      handler: async (req, res) => {
        if (req.method !== "GET" && req.method !== "HEAD") {
          sendText(res, 405, "Method Not Allowed");
          return true;
        }

        const url = new URL(req.url ?? "/", "http://localhost");
        if (!tokenMatches(url.searchParams.get("token"))) {
          sendText(res, 403, "Forbidden");
          return true;
        }

        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Referrer-Policy", "no-referrer");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("X-Frame-Options", "SAMEORIGIN");
        res.setHeader("Content-Security-Policy", DASHBOARD_CSP);
        res.end(req.method === "HEAD" ? "" : dashboardHtml);
        return true;
      },
    });

    api.logger.info?.(`[agent-display] dashboard route ready: ${dashboardInfo.route}`);

    return {
      info: () => ({ ...dashboardInfo, dashboardUrl: createDashboardUrl() }),
    };
  },
});
