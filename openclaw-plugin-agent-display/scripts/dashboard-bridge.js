(function () {
  "use strict";

  var root = document.getElementById("dq-live");
  if (!root) return;

  var pill = document.getElementById("dq-live-pill");
  var panel = document.getElementById("dq-live-panel");
  var reset = document.getElementById("dq-live-reset");
  var head = panel ? panel.querySelector(".dq-head") : null;
  var expanded = false;
  var firstSnapshot = true;
  var collapseTimer = null;
  var posKey = "agent-display:dq-live-position";
  var drag = null;
  var suppressClick = false;

  function readPos() {
    try {
      var raw = localStorage.getItem(posKey);
      if (!raw) return null;
      var pos = JSON.parse(raw);
      if (pos && isFinite(pos.left) && isFinite(pos.bottom)) return pos;
    } catch (error) {
      /* 忽略存储异常 */
    }
    return null;
  }

  function savePos(pos) {
    try {
      if (pos) localStorage.setItem(posKey, JSON.stringify(pos));
      else localStorage.removeItem(posKey);
    } catch (error) {
      /* 忽略存储异常 */
    }
  }

  function clampPos(left, bottom) {
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var rect = root.getBoundingClientRect();
    var w = rect.width || 0;
    var h = rect.height || 0;
    var maxLeft = Math.max(8, vw - w - 8);
    var maxBottom = Math.max(8, vh - h - 8);
    return {
      left: Math.min(Math.max(8, left), maxLeft),
      bottom: Math.min(Math.max(8, bottom), maxBottom),
    };
  }

  function positioned() {
    return root.style.left !== "" || root.getAttribute("data-positioned") === "true";
  }

  function place(pos) {
    var clamped = clampPos(pos.left, pos.bottom);
    root.style.left = clamped.left + "px";
    root.style.right = "auto";
    root.style.bottom = clamped.bottom + "px";
    root.style.top = "auto";
    root.setAttribute("data-positioned", "true");
    return clamped;
  }

  function restore() {
    var pos = readPos();
    if (!pos) return;
    place(pos);
  }

  function resetPosition() {
    savePos(null);
    root.style.left = "";
    root.style.right = "";
    root.style.bottom = "";
    root.style.top = "";
    root.removeAttribute("data-positioned");
    if (expanded) layoutPanel();
  }

  function currentPos() {
    var rect = root.getBoundingClientRect();
    return { left: rect.left, bottom: window.innerHeight - rect.bottom };
  }

  function startDrag(event) {
    if (event.button !== undefined && event.button !== 0) return;
    if (event.target && event.target.closest && event.target.closest(".dq-reset")) return;
    var rect = root.getBoundingClientRect();
    drag = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: rect.left,
      bottom: window.innerHeight - rect.bottom,
      moved: false,
    };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch (error) {
      /* 旧浏览器不支持 pointer capture */
    }
    root.setAttribute("data-dragging", "true");
  }

  function moveDrag(event) {
    if (!drag || event.pointerId !== drag.id) return;
    var dx = event.clientX - drag.x;
    var dy = event.clientY - drag.y;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
    drag.moved = true;
    var pos = clampPos(drag.left + dx, drag.bottom - dy);
    root.style.left = pos.left + "px";
    root.style.right = "auto";
    root.style.bottom = pos.bottom + "px";
    root.style.top = "auto";
    root.setAttribute("data-positioned", "true");
  }

  function endDrag(event) {
    if (!drag || event.pointerId !== drag.id) return;
    if (drag.moved) {
      var pos = event.type === "pointercancel"
        ? currentPos()
        : clampPos(drag.left + (event.clientX - drag.x), drag.bottom - (event.clientY - drag.y));
      savePos(place(pos));
      suppressClick = true;
      setTimeout(function () {
        suppressClick = false;
      }, 250);
    }
    root.removeAttribute("data-dragging");
    drag = null;
    if (expanded) layoutPanel();
  }

  function nudge(event) {
    if (!event.shiftKey) return;
    var step = event.altKey ? 48 : 12;
    var pos = currentPos();
    if (event.key === "ArrowLeft") pos.left -= step;
    else if (event.key === "ArrowRight") pos.left += step;
    else if (event.key === "ArrowUp") pos.bottom += step;
    else if (event.key === "ArrowDown") pos.bottom -= step;
    else return;
    savePos(place(pos));
    event.preventDefault();
    event.stopPropagation();
  }

  function layoutPanel() {
    if (panel.hidden) return;
    var rect = pill.getBoundingClientRect();
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var above = rect.top - 16;
    var below = vh - rect.bottom - 16;
    var place = above >= below ? "above" : "below";
    if (above < 120) place = "below";
    else if (below < 120) place = "above";
    root.setAttribute("data-placement", place);
    root.setAttribute("data-align", rect.left + rect.width / 2 > vw / 2 ? "right" : "left");
    panel.style.maxHeight = Math.max(160, Math.min(520, place === "above" ? above : below)) + "px";
  }

  function setExpanded(value) {
    expanded = value;
    panel.hidden = !value;
    pill.setAttribute("aria-expanded", String(value));
    root.setAttribute("data-expanded", String(value));
    if (value) {
      layoutPanel();
      if (positioned()) savePos(place(currentPos()));
    }
  }

  pill.addEventListener("click", function () {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    if (collapseTimer) {
      clearTimeout(collapseTimer);
      collapseTimer = null;
    }
    setExpanded(!expanded);
  });

  pill.addEventListener("pointerdown", startDrag);
  if (head) head.addEventListener("pointerdown", startDrag);
  pill.addEventListener("keydown", nudge);
  if (reset) {
    reset.addEventListener("click", function (event) {
      event.stopPropagation();
      resetPosition();
    });
  }
  window.addEventListener("pointermove", moveDrag, { passive: true });
  window.addEventListener("pointerup", endDrag);
  window.addEventListener("pointercancel", endDrag);
  window.addEventListener("resize", function () {
    if (positioned()) savePos(place(currentPos()));
    if (expanded) layoutPanel();
  });
  restore();

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
