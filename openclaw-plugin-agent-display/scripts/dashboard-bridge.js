(function () {
  "use strict";

  var root = document.getElementById("dq-live");
  if (!root) return;

  var pill = document.getElementById("dq-live-pill");
  var panel = document.getElementById("dq-live-panel");
  var expanded = false;
  var firstSnapshot = true;
  var collapseTimer = null;

  function setExpanded(value) {
    expanded = value;
    panel.hidden = !value;
    pill.setAttribute("aria-expanded", String(value));
    root.setAttribute("data-expanded", String(value));
  }

  pill.addEventListener("click", function () {
    if (collapseTimer) {
      clearTimeout(collapseTimer);
      collapseTimer = null;
    }
    setExpanded(!expanded);
  });

  document.addEventListener(
    "keydown",
    function (event) {
      if (event.key === "Escape" && expanded) {
        setExpanded(false);
        event.stopPropagation();
      }
    },
    true,
  );

  function number(value) {
    return typeof value === "number" && isFinite(value) ? value : 0;
  }

  function fmt(value) {
    return Math.round(number(value)).toLocaleString("en-US");
  }

  function compact(value) {
    var n = number(value);
    if (Math.abs(n) >= 1000000) return (n / 1000000).toFixed(1) + "M";
    if (Math.abs(n) >= 1000) return (n / 1000).toFixed(1) + "k";
    return String(Math.round(n));
  }

  function money(value) {
    return "$" + number(value).toFixed(2);
  }

  function node(tag, className, text) {
    var element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined && text !== null) element.textContent = String(text);
    return element;
  }

  function clear(element) {
    while (element.firstChild) element.removeChild(element.firstChild);
  }

  function metric(label, value, hint) {
    var cell = node("div", "dq-metric");
    cell.appendChild(node("span", "dq-metric-label", label));
    cell.appendChild(node("b", "dq-metric-value", value));
    if (hint) cell.appendChild(node("small", "dq-metric-hint", hint));
    return cell;
  }

  function renderMetrics(snapshot) {
    var metrics = snapshot.metrics || {};
    var box = document.getElementById("dq-metrics");
    clear(box);
    box.appendChild(metric("AGENTS", fmt(metrics.agents), fmt(metrics.activeAgents) + " active"));
    box.appendChild(
      metric(
        "SESSIONS",
        fmt(metrics.activeSessions) + " / " + fmt(metrics.totalSessions),
        "active / total",
      ),
    );
    box.appendChild(
      metric(
        "CHANNELS",
        fmt(metrics.channelsOnline) + " / " + fmt(metrics.channelsTotal),
        "online / total",
      ),
    );
    box.appendChild(metric("TOKENS", compact(metrics.tokens), "30d"));
    box.appendChild(metric("COST", money(metrics.cost), "30d"));
    box.appendChild(metric("CRON", fmt(metrics.cronJobs), "jobs"));
  }

  function renderAgents(snapshot) {
    var box = document.getElementById("dq-agents");
    clear(box);
    var agents = (snapshot.agents || []).slice(0, 8);
    if (!agents.length) {
      box.appendChild(node("div", "dq-empty", "暂无 agent 数据"));
      return;
    }

    agents.forEach(function (agent) {
      var row = node("div", "dq-row");
      var main = node("div", "dq-row-main");
      main.appendChild(node("b", "", agent.name || agent.id || "agent"));
      var meta = [agent.id || "", agent.model || ""].filter(Boolean).join(" · ");
      main.appendChild(node("small", "", meta));

      var side = node("div", "dq-row-side");
      side.appendChild(node("span", "dq-badge" + (agent.active ? " on" : ""), agent.active ? "ACTIVE" : "IDLE"));
      side.appendChild(node("small", "", fmt(agent.sessions) + " sess"));

      row.appendChild(main);
      row.appendChild(side);
      box.appendChild(row);
    });
  }

  function renderEvents(snapshot) {
    var box = document.getElementById("dq-events");
    clear(box);
    var events = (snapshot.events || []).slice(0, 6);
    if (!events.length) {
      box.appendChild(node("div", "dq-empty", "暂无事件"));
      return;
    }

    events.forEach(function (event) {
      var row = node("div", "dq-event");
      row.appendChild(node("time", "", event.time || "--:--"));
      row.appendChild(node("span", "dq-tag", event.tag || "EVT"));
      row.appendChild(node("span", "dq-event-text", event.text || ""));
      box.appendChild(row);
    });
  }

  function applyTheme(snapshot) {
    try {
      if (typeof window.__DQ_SET_SNAPSHOT__ === "function") window.__DQ_SET_SNAPSHOT__(snapshot);
      if (typeof window.__DQ_APPLY__ === "function") window.__DQ_APPLY__(snapshot);
    } catch (error) {
      console.error("[agent-display] theme data failed", error);
    }
  }

  function render(snapshot) {
    snapshot = snapshot || {};
    applyTheme(snapshot);
    var ok = snapshot.gateway && snapshot.gateway.ok === true;
    root.setAttribute("data-ok", ok ? "true" : "false");
    document.getElementById("dq-status-text").textContent = ok ? "LIVE" : "DEGRADED";

    var metrics = snapshot.metrics || {};
    var summary =
      snapshot.summary ||
      fmt(metrics.agents) + " agents · " + fmt(metrics.activeSessions) + " active · " + compact(metrics.tokens) + " tok";
    document.getElementById("dq-pill-summary").textContent = summary;

    renderMetrics(snapshot);
    renderAgents(snapshot);
    renderEvents(snapshot);

    var updated = snapshot.updatedAt ? new Date(snapshot.updatedAt).toLocaleTimeString() : "--:--:--";
    document.getElementById("dq-updated").textContent = "更新 " + updated + (snapshot.gateway && snapshot.gateway.version ? " · " + snapshot.gateway.version : "");

    var errors = (snapshot.errors || []).join(" · ");
    document.getElementById("dq-errors").textContent = errors ? "⚠ " + errors : "";

    if (firstSnapshot && snapshot.updatedAt) {
      firstSnapshot = false;
      setExpanded(true);
      if (collapseTimer) clearTimeout(collapseTimer);
      collapseTimer = setTimeout(function () {
        setExpanded(false);
      }, 5000);
    }
  }

  window.addEventListener("message", function (event) {
    if (!event.data || event.data.type !== "agent-display:snapshot") return;
    render(event.data.snapshot || {});
  });

  window.__DQ_LIVE__ = { render: render };

  parent.postMessage({ type: "agent-display:ready" }, "*");
})();
