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
      // 把 session 标题放到 titles[0] 作为当前任务
      if (real.sessions && sessionList.length) {
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
})();
