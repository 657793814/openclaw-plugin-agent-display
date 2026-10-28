import { Type } from "typebox";
import { defineFeatureContract } from "openclaw/plugin-sdk/feature-contract";
import { DASHBOARD_ROUTE, PLUGIN_ID, PLUGIN_VERSION } from "./shared.js";

export const contract = defineFeatureContract({
  pluginId: PLUGIN_ID,
  operations: {
    info: {
      kind: "query",
      description: "Return the Agent Display dashboard route, version, and authenticated iframe URL.",
      input: Type.Object({}, { additionalProperties: false }),
      output: Type.Object({
        route: Type.String(),
        version: Type.String(),
        dashboardUrl: Type.String(),
      }),
    },
  },
  events: {},
});

export const dashboardInfo = {
  route: DASHBOARD_ROUTE,
  version: PLUGIN_VERSION,
};
