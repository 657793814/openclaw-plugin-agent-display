(function () {
  "use strict";

  var snapshot = null;

  function clip(value, max) {
    var text = String(value === undefined || value === null ? "" : value)
      .replace(/\s+/g, " ")
      .trim();
    if (!text) return "";
    return text.length > max ? text.slice(0, Math.max(1, max - 1)) + "…" : text;
  }

  function rows(key) {
    if (!snapshot || !Array.isArray(snapshot[key])) return [];
    return snapshot[key];
  }

  function agents() {
    return rows("agents");
  }

  function sessions() {
    return rows("sessions");
  }

  function channels() {
    return rows("channels");
  }

  function sessionTitle(session) {
    return clip(session.title || session.key || session.agentId || "session", 18);
  }

  function clock(ts) {
    if (!ts || !isFinite(ts)) return "--:--";
    try {
      return new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });
    } catch (error) {
      return "--:--";
    }
  }

  function agentName(agent, index) {
    return clip(agent.name || agent.id || "agent " + (index + 1), 10);
  }

  function modelName(agent) {
    var model = String(agent.model || "").split("/").pop();
    return clip(model || (agent.active ? "运行中" : "待命"), 20);
  }

  function agentKey(agent, index) {
    var raw = String(agent.id || agent.name || "agent" + (index + 1))
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    return clip(raw || "AGENT" + (index + 1), 10);
  }

  function uniqueKey(key, used, index) {
    var next = key || "AGENT" + (index + 1);
    var suffix = 2;
    while (used[next]) {
      next = clip(String(key || "AGENT") + suffix, 10);
      suffix += 1;
    }
    used[next] = true;
    return next;
  }

  function isSentinel(agent) {
    return agent && (agent.k === "CRAWLER" || agent.tag === "PATROL");
  }

  function idleAgent(agent, index) {
    var code = index + 1 < 10 ? "0" + (index + 1) : String(index + 1);
    agent.k = "IDLE" + code;
    agent.id = "standby-" + code;
    agent.zh = "待命";
    agent.role = "暂无任务";
    agent.tag = agent.tag === "PATROL" ? agent.tag : "IDLE";
    agent.sessions = 0;
    agent.active = false;
    return agent;
  }

  function mergeAgents(base) {
    var list = agents();
    if (!list.length) return base;
    var used = {};
    var usedIds = {};
    var cursor = 0;
    return base.map(function (agent, index) {
      if (isSentinel(agent)) return agent;
      var real = list[cursor];
      cursor += 1;
      if (!real) return idleAgent(agent, index);
      var key = uniqueKey(agentKey(real, cursor - 1), used, index);
      var label = agentName(real, cursor - 1) || key;
      var id = label;
      var suffix = 2;
      while (usedIds[id]) {
        id = clip(label + suffix, 14);
        suffix += 1;
      }
      usedIds[id] = true;
      agent.legacy = agent.id;
      agent.sourceId = real.id || key;
      agent.k = key;
      agent.id = id;
      agent.zh = label;
      agent.role = modelName(real);
      agent.sessions = real.sessions || 0;
      agent.active = real.active === true;
      return agent;
    });
  }

  function mergeWorkflows(base) {
    var list = sessions();
    if (!list.length) return base;
    return base.map(function (workflow, index) {
      var title = sessionTitle(list[index % list.length]);
      var names = [];
      for (var offset = 0; offset < 3; offset += 1) {
        var next = sessionTitle(list[(index + offset * base.length) % list.length]);
        if (next && names.indexOf(next) < 0) names.push(next);
      }
      workflow.zh = clip(title, 12);
      workflow.names = names.length ? names : [title];
      return workflow;
    });
  }

  function mergeChannels(base) {
    var list = channels();
    if (!list.length) return base;
    return base.map(function (channel, index) {
      var real = list[index];
      if (!real) {
        channel.zh = "其他";
        if ("en" in channel) channel.en = "OTHER";
        channel.id = "other-" + index;
        channel.on = false;
        return channel;
      }
      channel.zh = clip(real.label || real.id, 10);
      if ("en" in channel) channel.en = clip(String(real.id || "").toUpperCase(), 10);
      channel.id = real.id;
      channel.on = real.running === true || real.connected === true;
      return channel;
    });
  }

  function mergeProjects(base) {
    var list = sessions();
    if (!list.length) return base;
    return base.map(function (project, index) {
      var span = project.subs.length;
      project.name = clip(sessionTitle(list[(index * span) % list.length]), 18) || project.name;
      project.subs = project.subs.map(function (fallback, partIndex) {
        return sessionTitle(list[(index * span + partIndex) % list.length]) || fallback;
      });
      return project;
    });
  }

  function mergeJobs(base) {
    var list = sessions();
    if (!list.length) return base;
    var known = {};
    agents().forEach(function (agent) {
      known[agent.id] = true;
    });
    return base.map(function (job, index) {
      var span = Math.max(1, Math.floor(list.length / base.length));
      var offset = index * span;
      job.title = clip(sessionTitle(list[offset % list.length]), 18) || job.title;
      var items = Array.isArray(job.parts) ? job.parts : Array.isArray(job.secs) ? job.secs : null;
      if (!items) return job;
      var mapped = items.map(function (part, partIndex) {
        var session = list[(offset + partIndex) % list.length];
        if (!session) return part;
        part.task = clip(sessionTitle(session), 18) || part.task;
        if (known[session.agentId]) part.ag = session.agentId;
        return part;
      });
      if (Array.isArray(job.parts)) job.parts = mapped;
      else job.secs = mapped;
      return job;
    });
  }

  function mergeCases(base) {
    var list = sessions();
    if (!list.length) return base;
    return base.map(function (item, index) {
      var session = list[index % list.length];
      item.zh = clip(sessionTitle(session), 10) || item.zh;
      item.en = clip(String(session.agentId || "agent").toUpperCase(), 16) || item.en;
      item.conf = session.active === true ? 0.94 : 0.89;
      item.path = item.path.map(function (part) {
        return part.slice();
      });
      if (item.path[0]) item.path[0][1] = clip(session.agentId || "session", 12);
      if (item.path[5]) {
        item.path[5][1] = session.active === true ? "运行中" : "更新 " + clock(session.updatedAt);
      }
      return item;
    });
  }

  function mergeCaseLabels(base) {
    var list = sessions();
    if (!list.length) return base;
    return base.map(function (fallback, index) {
      var session = list[index % list.length];
      return clip(sessionTitle(session), 4) || fallback;
    });
  }

  function mergeOpsConfig(config) {
    var agentList = agents();
    var sessionList = sessions();
    if (agentList.length) {
      config.agents = config.agents.map(function (pair, index) {
        var real = agentList[index];
        var code = index + 1 < 10 ? "0" + (index + 1) : String(index + 1);
        return [code, real ? agentName(real, index) : "待命"];
      });
    }
    if (sessionList.length) {
      config.taskNames = config.taskNames.map(function (fallback, index) {
        return sessionTitle(sessionList[index % sessionList.length]) || fallback;
      });
      config.workflows = config.workflows.map(function (fallback, index) {
        return clip(sessionTitle(sessionList[index % sessionList.length]), 12) || fallback;
      });
    }
    return config;
  }

  function mergeParkWorkshops(base, theme) {
    var agentList = agents();
    if (!agentList.length) return base;
    return base.map(function (ws, index) {
      var real = agentList[index];
      if (!real) return ws;
      ws.ag = agentName(real, index) || ws.ag;
      ws.id = (real.id || ws.id);
      // 把会话标题放到 titles[0] 作为当前任务
      if (real.sessions) {
        var st = sessionTitle(real);
        if (st && ws.titles) ws.titles[0] = st;
      }
      return ws;
    });
  }

  function mergeParkChannels(base) {
    var channelList = channels();
    if (!channelList.length) return base;
    return base.map(function (ch, index) {
      var real = channelList[index];
      if (!real) return ch;
      ch.zh = clip(real.label || real.id, 12) || ch.zh;
      return ch;
    });
  }

  /* =================================================================
     实时数据投影：把 OpenClaw snapshot 归一化成两款大屏需要的领域模型。
     外部连接器（Jira / GitHub / CRM …）只要产出同构的 sessions/workItems，
     大屏侧不需要再改。
     ================================================================= */
  var DEPT_META = [
    { id: "D1", zh: "产品部", en: "PRODUCT", c: "#ffb547" },
    { id: "D2", zh: "设计部", en: "DESIGN", c: "#ff7eb6" },
    { id: "D3", zh: "市场部", en: "MARKETING", c: "#ff7a59" },
    { id: "D4", zh: "运营部", en: "OPERATIONS", c: "#4fe0a6" },
    { id: "D5", zh: "研发部", en: "ENGINEERING", c: "#5cc8ff" },
    { id: "D6", zh: "人事部", en: "PEOPLE · HR", c: "#b99bff" },
    { id: "D7", zh: "财务部", en: "FINANCE", c: "#c8e05a" },
    { id: "D8", zh: "法务行政部", en: "LEGAL & ADMIN", c: "#e0b48a" },
  ];

  function clamp01(value) {
    var n = Number(value);
    if (!isFinite(n)) return 0;
    return n < 0 ? 0 : (n > 1 ? 1 : n);
  }

  function sessionStage(session) {
    var status = String((session && session.status) || "").toLowerCase();
    if (status === "queued" || status === "running" || status === "review" || status === "done" || status === "failed") {
      return status;
    }
    if (session && session.stage) return String(session.stage);
    if (session && session.active === true) return "running";
    var age = Date.now() - Number((session && session.updatedAt) || 0);
    return age < 10 * 60 * 1000 ? "review" : "done";
  }

  function sessionProgress(session) {
    if (session && typeof session.progress === "number") return clamp01(session.progress);
    var stage = sessionStage(session);
    if (stage === "done") return 1;
    if (stage === "review") return 0.8;
    if (stage === "running") return 0.55;
    if (stage === "failed") return 0.35;
    return 0.08;
  }

  function shortName(value, max) {
    var text = clip(value, max || 6);
    return text || "Agent";
  }

  function modelShort(agent) {
    var model = String((agent && agent.model) || "").split("/").pop();
    return clip(model || "agent", 18);
  }

  function titlesFor(agent, allSessions) {
    var out = [];
    allSessions.forEach(function (session) {
      if (session.agentId !== agent.id && session.agentId !== agent.name) return;
      var title = sessionTitle(session);
      if (title && out.indexOf(title) < 0) out.push(title);
    });
    return out;
  }

  function eventWithAgent(event, agentList) {
    var agentId = event && event.agentId;
    var index = -1;
    if (agentId) {
      agentList.some(function (agent, i) {
        if (agent.id === agentId || agent.name === agentId) { index = i; return true; }
        return false;
      });
    }
    if (index < 0 && event && event.text) {
      agentList.some(function (agent, i) {
        var label = String(agent.name || agent.id || "");
        if (label && String(event.text).indexOf(label) >= 0) { index = i; return true; }
        return false;
      });
    }
    return {
      key: (event && (event.key || (event.ts + "|" + event.tag + "|" + event.text))) || "",
      time: (event && event.time) || clock(Date.now()),
      tag: (event && event.tag) || "EVT",
      text: clip((event && event.text) || "", 90),
      kind: (event && event.kind) || "",
      agentIndex: index,
    };
  }

  function metricsOf(snapshot) {
    var m = (snapshot && snapshot.metrics) || {};
    var allSessions = sessions();
    var allAgents = agents();
    var allChannels = channels();
    var total = Number(m.totalSessions);
    if (!isFinite(total) || total <= 0) total = allSessions.length;
    var active = Number(m.activeSessions);
    if (!isFinite(active) || active < 0) active = allSessions.filter(function (s) { return s.active === true; }).length;
    var agentsN = Number(m.agents);
    if (!isFinite(agentsN) || agentsN <= 0) agentsN = allAgents.length;
    var activeAgents = Number(m.activeAgents);
    if (!isFinite(activeAgents) || activeAgents < 0) activeAgents = allAgents.filter(function (a) { return a.active === true; }).length;
    var channelsTotal = Number(m.channelsTotal);
    if (!isFinite(channelsTotal) || channelsTotal < 0) channelsTotal = allChannels.length;
    var channelsOnline = Number(m.channelsOnline);
    if (!isFinite(channelsOnline) || channelsOnline < 0) channelsOnline = allChannels.filter(function (c) { return c.running === true || c.connected === true; }).length;
    var failed = allSessions.filter(function (s) { return sessionStage(s) === "failed"; }).length;
    var errors = (snapshot && Array.isArray(snapshot.errors) ? snapshot.errors.length : 0) + failed;
    var ages = allSessions.map(function (s) {
      var at = Number(s.updatedAt) || Date.now();
      return Math.max(0, Date.now() - at) / 60000;
    });
    var avgAge = ages.length ? ages.reduce(function (a, b) { return a + b; }, 0) / ages.length : 0;
    var recentAge = ages.length ? Math.min.apply(null, ages) : 0;
    var busiest = "—";
    var busiestN = -1;
    allAgents.forEach(function (agent) {
      var n = Number(agent.sessions) || 0;
      if (n > busiestN) { busiestN = n; busiest = shortName(agent.name || agent.id, 12) + " · " + n + " 会话"; }
    });
    return {
      agents: agentsN,
      activeAgents: activeAgents,
      totalSessions: total,
      activeSessions: active,
      completedSessions: Math.max(0, total - active),
      channelsTotal: channelsTotal,
      channelsOnline: channelsOnline,
      channelRate: channelsTotal ? (channelsOnline / channelsTotal) * 100 : 100,
      successRate: total ? Math.max(0, 100 - (errors / Math.max(1, total)) * 100) : 100,
      avgAgeMin: avgAge,
      recentAgeMin: recentAge,
      errors: errors,
      tokens: Number(m.tokens) || 0,
      cost: Number(m.cost) || 0,
      cronJobs: Number(m.cronJobs) || 0,
      models: Number(m.models) || 0,
      events: (snapshot && Array.isArray(snapshot.events) ? snapshot.events.length : 0),
      busiest: busiest,
    };
  }

  function projectPark(snapshot) {
    if (!snapshot || typeof snapshot !== "object") return null;
    var allAgents = agents();
    var allSessions = sessions();
    var allChannels = channels();
    var metrics = metricsOf(snapshot);
    var ordered = allSessions.slice().sort(function (a, b) {
      return (b.active === true ? 1 : 0) - (a.active === true ? 1 : 0) || (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0);
    });
    var globalTitles = [];
    ordered.forEach(function (s) {
      var t = sessionTitle(s);
      if (t && globalTitles.indexOf(t) < 0) globalTitles.push(t);
    });
    var workshops = [];
    for (var i = 0; i < 6; i += 1) {
      var agent = allAgents[i];
      if (!agent) {
        workshops.push({
          id: "",
          agent: "待命",
          role: "暂无 Agent",
          sessions: 0,
          active: false,
          titles: globalTitles.slice(i, i + 4),
          rate: 0,
        });
        continue;
      }
      var own = titlesFor(agent, allSessions);
      var titles = own.slice(0, 8);
      for (var g = 0; titles.length < 4 && g < globalTitles.length; g += 1) {
        if (titles.indexOf(globalTitles[g]) < 0) titles.push(globalTitles[g]);
      }
      workshops.push({
        id: agent.id || "",
        agent: shortName(agent.name || agent.id, 12),
        role: modelShort(agent),
        sessions: Number(agent.sessions) || own.length || 0,
        active: agent.active === true,
        titles: titles,
        rate: agent.active === true ? 1 : 0.35,
      });
    }
    var channelLabels = allChannels.map(function (channel) {
      return clip(channel.label || channel.id || "渠道", 10);
    });
    var events = [];
    (Array.isArray(snapshot.events) ? snapshot.events : []).forEach(function (event) {
      events.push(eventWithAgent(event, allAgents));
    });
    return {
      workshops: workshops,
      channels: channelLabels,
      events: events,
      kpis: metrics,
      channelRows: allChannels,
      agentRows: allAgents,
    };
  }

  function deptOfAgent(agent) {
    var hay = [agent && agent.id, agent && agent.name, agent && agent.team, agent && agent.role]
      .filter(Boolean).join(" ").toLowerCase().replace(/agent/g, " ");
    var rules = [
      [/design|视觉|设计|ui|ux|前端|front|图|brand|品牌/, 1],
      [/market|营销|市场|content|内容|文案|video|视频|推广|growth|增长/, 2],
      [/ops|运营|support|客服|community|社群|活动|operation/, 3],
      [/dev|code|eng|研发|代码|backend|后端|test|测试|运维|deploy|发布|infra|架构/, 4],
      [/hr|people|招聘|人事|培训|recruit|talent/, 5],
      [/fin|财务|会计|budget|预算|cost|核算|税务/, 6],
      [/legal|法务|合同|compliance|合规|行政|admin|归档/, 7],
      [/product|产品|pm|需求|research|用户研究/, 0],
    ];
    for (var i = 0; i < rules.length; i += 1) if (rules[i][0].test(hay)) return rules[i][1];
    var seed = 0;
    String((agent && (agent.id || agent.name)) || "").split("").forEach(function (ch) { seed += ch.charCodeAt(0); });
    return seed % DEPT_META.length;
  }

  function projectHQ(snapshot) {
    if (!snapshot || typeof snapshot !== "object") return null;
    var allAgents = agents();
    var allSessions = sessions();
    var metrics = metricsOf(snapshot);
    var people = allAgents.map(function (agent, index) {
      return {
        id: agent.id || ("agent-" + index),
        name: shortName(agent.name || agent.id, 6),
        role: modelShort(agent),
        model: agent.model || "",
        dept: deptOfAgent(agent),
        active: agent.active === true,
        sessions: Number(agent.sessions) || 0,
        tokens: Number(agent.tokens) || 0,
        index: index,
      };
    });
    var projects = allSessions.slice().sort(function (a, b) {
      return (b.active === true ? 1 : 0) - (a.active === true ? 1 : 0) || (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0);
    }).slice(0, 8).map(function (session) {
      var owner = null;
      for (var i = 0; i < people.length; i += 1) {
        if (people[i].id === session.agentId || people[i].name === session.agentId) { owner = people[i]; break; }
      }
      return {
        id: session.key,
        title: clip(session.title || session.key || "会话", 20),
        agentId: session.agentId,
        agentName: owner ? owner.name : shortName(session.agentId || "Agent", 6),
        stage: sessionStage(session),
        progress: sessionProgress(session),
        active: session.active === true,
        updatedAt: Number(session.updatedAt) || 0,
      };
    });
    var depts = DEPT_META.map(function (meta, k) {
      var members = people.filter(function (person) { return person.dept === k; });
      var sessionsN = members.reduce(function (sum, person) { return sum + person.sessions; }, 0);
      var active = members.filter(function (person) { return person.active; }).length;
      var completed = 0;
      allSessions.forEach(function (session) {
        if (members.some(function (person) { return person.id === session.agentId || person.name === session.agentId; }) && sessionStage(session) === "done") completed += 1;
      });
      var progress = sessionsN ? Math.min(1, completed / Math.max(1, sessionsN)) : (active ? 0.4 : 0);
      return {
        id: meta.id,
        zh: meta.zh,
        en: meta.en,
        c: meta.c,
        agents: members.length,
        active: active,
        sessions: sessionsN,
        completed: completed,
        progress: progress,
        lead: members.length ? members[0].name : "空缺",
      };
    });
    var progressSum = projects.reduce(function (sum, project) { return sum + project.progress; }, 0);
    var events = [];
    (Array.isArray(snapshot.events) ? snapshot.events : []).forEach(function (event) {
      var row = eventWithAgent(event, allAgents);
      var owner = row.agentIndex >= 0 ? people[row.agentIndex] : null;
      row.dept = owner ? owner.dept : -1;
      events.push(row);
    });
    return {
      departments: depts,
      people: people,
      projects: projects,
      events: events,
      chiefName: people.length ? people[0].name : "Chief",
      kpis: {
        agents: metrics.agents,
        activeAgents: metrics.activeAgents,
        totalSessions: metrics.totalSessions,
        activeSessions: metrics.activeSessions,
        completedSessions: metrics.completedSessions,
        reviewSessions: allSessions.filter(function (s) { return sessionStage(s) === "review"; }).length,
        tokens: metrics.tokens,
        cost: metrics.cost,
        progress: projects.length ? progressSum / projects.length : 0,
        avgAgeMin: metrics.avgAgeMin,
        recentAgeMin: metrics.recentAgeMin,
        errors: metrics.errors,
        channelsOnline: metrics.channelsOnline,
        channelsTotal: metrics.channelsTotal,
        eventCount: events.length,
        busiest: metrics.busiest,
      },
    };
  }

  function setSnapshot(next) {
    snapshot = next && typeof next === "object" ? next : null;
  }

  window.__DQ_SET_SNAPSHOT__ = setSnapshot;
  window.__DQ_GET_SNAPSHOT__ = function () {
    return snapshot;
  };
  window.__DQ_MERGE_AGENTS__ = mergeAgents;
  window.__DQ_MERGE_WORKFLOWS__ = mergeWorkflows;
  window.__DQ_MERGE_CHANNELS__ = mergeChannels;
  window.__DQ_MERGE_PROJECTS__ = mergeProjects;
  window.__DQ_MERGE_JOBS__ = mergeJobs;
  window.__DQ_MERGE_CASES__ = mergeCases;
  window.__DQ_MERGE_CASE_LABELS__ = mergeCaseLabels;
  window.__DQ_MERGE_OPS_CONFIG__ = mergeOpsConfig;
  window.__DQ_MERGE_PARK_WORKSHOPS__ = mergeParkWorkshops;
  window.__DQ_MERGE_PARK_CHANNELS__ = mergeParkChannels;
  window.__DQ_PROJECT_PARK__ = projectPark;
  window.__DQ_PROJECT_HQ__ = projectHQ;
})();
