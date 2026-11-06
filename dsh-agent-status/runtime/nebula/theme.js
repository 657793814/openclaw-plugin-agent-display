function mountNebula(host, SR){
'use strict';

/* ================= 0. 工具 ================= */
const $ = s => SR.querySelector(s), $$ = s => SR.querySelectorAll(s);
const TAU = Math.PI * 2, HP = Math.PI / 2;
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = a => a[(Math.random() * a.length) | 0];
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, t) => a + (b - a) * t;
const pad = (n, w = 2) => String(n).padStart(w, '0');
const fmt = n => Math.round(n).toLocaleString('en-US');
const hms = d => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const hex3 = h => { const n = parseInt(h.slice(1), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; };
const ease2 = u => u < .5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };
function mulberry32(a){ return function(){ a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const rng = mulberry32(20261023);
const gauss = () => { let u = 0, v = 0; while (u === 0) u = rng(); v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v); };
const angLerp = (a, b, t) => { let d = (b - a) % TAU; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU; return a + d * t; };
const minsToday = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };

/* ================= 1. 槽位调色板（原主题 12 团星云的配色；身份/阶段文字全部来自真实事件） ================= */
const AG = [
  {k:"HOST", zh:"Harness", role:"只读事件源", col:"#f4f7ff"},
  {k:"", zh:"", role:"", col:"#7cc8ff"},
  {k:"", zh:"", role:"", col:"#a093ff"},
  {k:"", zh:"", role:"", col:"#ff86c2"},
  {k:"", zh:"", role:"", col:"#ffae80"},
  {k:"", zh:"", role:"", col:"#49e3f2"},
  {k:"", zh:"", role:"", col:"#8ef0c4"},
  {k:"", zh:"", role:"", col:"#ffd27a"},
  {k:"", zh:"", role:"", col:"#6f8dff"},
  {k:"", zh:"", role:"", col:"#ff9a6a"},
  {k:"", zh:"", role:"", col:"#e07bff"},
  {k:"", zh:"", role:"", col:"#9ee6ff"},
  {k:"", zh:"", role:"", col:"#d6c4ff"},
  {k:"CRAWLER", zh:"星云蛛", role:"逐条读真实调用", col:"#d8ecff"}
];
const CRAWLER = 13;
const PASS = 80;
const AXES = ['工具', '结果', '错误', '确认', '完成', '事件', '轮次'];
const AGC = AG.map(a => hex3(a.col));
const S = .44;
let SS = S;                                     // 当前实际缩放：趴在星核上时放大一点，免得被星核吃掉                                 // 星云蛛整体缩放

/* ================= 2. 星图布局 ================= */
// 12 团星云分在三条椭圆公转轨道上，绕着正中的 CHIEF 转（里圈快、外圈慢）；每团顺着轨道方向拉长一点。
// 每团星云有自己的局部坐标（x 顺着轨道方向），词位、星云蛛的位置都记在局部坐标里，所以会跟着星云一起公转。
const ORBITS = [{ax: 19.5, az: 11.2, n: 3, R: 4.6, T: 150}, {ax: 30, az: 16.8, n: 4, R: 5.3, T: 230}, {ax: 40.5, az: 22.4, n: 5, R: 5.8, T: 320}];
const CORE_Y = 2.2, CORE_R = 6.3;                // 星核中心高度 / 星云蛛趴的那层「球面」半径
const CL = [{core: true, x: 0, z: 0, R: CORE_R, cr: 1, sr: 0, y0: CORE_Y, top: CORE_R, cy: CORE_Y, words: []}];
{ let k = 1; ORBITS.forEach((o, oi) => { const ph = rng() * TAU; for (let j = 0; j < o.n; j++, k++) {
  const c = {orb: oi, ph: ph + j * TAU / o.n + (rng() - .5) * .3, R: o.R * (.92 + rng() * .16), y0: (rng() - .5) * .9, words: [], seed: rng() * TAU, x: 0, z: 0, cr: 1, sr: 0};
  c.top = c.R * .32; c.cy = c.y0 + c.top + .3; CL.push(c);
} }); }
let orbT = 37;
function orbitStep(){
  for (let k = 1; k <= 12; k++) {
    const c = CL[k], o = ORBITS[c.orb], f = c.ph + TAU * orbT / o.T;
    c.x = Math.cos(f) * o.ax; c.z = Math.sin(f) * o.az;
    const tx = -Math.sin(f) * o.ax, tz = Math.cos(f) * o.az, tl = Math.hypot(tx, tz);
    const rot = Math.atan2(-tz / tl, tx / tl); c.rot = rot; c.cr = Math.cos(rot); c.sr = Math.sin(rot);
  }
}
orbitStep();
// 局部 ↔ 世界（和 three.js 的 rotation.y 一致）
function anchorW(a, lx, lz, out = {}){ const c = CL[a]; out.x = c.x + lx * c.cr + lz * c.sr; out.z = c.z - lx * c.sr + lz * c.cr; out.y = surfL(c, lx, lz); return out; }
function toLocal(c, wx, wz){ const dx = wx - c.x, dz = wz - c.z; return [dx * c.cr - dz * c.sr, dx * c.sr + dz * c.cr]; }
// 表面高度：星云是一团鼓起来的云顶；星核是个球，星云蛛趴在球顶上
function surfL(c, lx, lz){
  if (c.core) return CORE_Y + Math.sqrt(Math.max(0, CORE_R * CORE_R - lx * lx - lz * lz)) * .95;
  const q = (lx / (c.R * 1.12)) ** 2 + (lz / (c.R * .9)) ** 2; return c.y0 + c.top * Math.exp(-q * 2.1);
}
function surfW(c, wx, wz){ const [lx, lz] = toLocal(c, wx, wz); return surfL(c, lx, lz); }
CL.slice(1).forEach(c => { for (let j = 0; j < 14; j++) { const ang = c.seed + j * 2.39996, rad = c.R * (.2 + .7 * Math.sqrt((j + .5) / 14)), lx = Math.cos(ang) * rad * 1.1, lz = Math.sin(ang) * rad * .85; c.words.push({lx, lz, y: surfL(c, lx, lz) + .3 + rng() * .45}); } });
const REST = {a: 0, lx: 0, lz: 3.1};               // 待命：趴在星核球面朝镜头的那一侧
// 跳进一团星云时，落在靠近来路那一侧的云顶上，然后再往里扒
const standOf = k => { const c = CL[k], [lx, lz] = toLocal(c, spider.x, spider.z), L = Math.hypot(lx / 1.1, lz / .85) || 1; return {a: k, lx: lx / L * c.R * .55, lz: lz / L * c.R * .42}; };

/* ================= 3. 真实数据适配（原模拟引擎整段移除，渲染管线不变） ================= */
// 这一节只把 Harness 快照翻译成原主题已经消费的数据结构：
// task / sections / words / AG / load / flash / logs / crawl / spider。
// 没有随机造数据，没有假的 agent→agent 派单；缺的槽位保持空或中性。
const NC = globalThis.__DSH_NEBULA_CORE__;
let simT = 0, animT = 0, frameN = 0;
let shipped = 0, wordsToday = 0, fixesToday = 0;
const scoreHist = [];
const load = AG.map(() => 0), loadTarget = AG.map(() => 0), flash = AG.map(() => 0);
let task = null;
const crawl = {phase: 'brief', t: 0, sec: -1, wi: 0, wt: 0, ship: 0};
const logs = []; let logDirty = true;
const readTimes = [];
let codeHL = 1, codeChars = 0, capText = '—';
const jobs = [];
const later = (s, fn) => jobs.push({t: simT + s, fn});

/* ---- 大屏控制器 → 主题的数据入口（唯一的数据源） ---- */
let snap = null;              // 最近一次 /api/state 或 SSE 快照
let transport = 'connecting'; // connecting | live | poll | offline | denied
let paused = false;           // 用户按了「暂停刷新」
let quiet = false;            // 长时间没有事件（正常静默，不是断线）
let alive = true;
let bootAt = 0;
let booted = false;           // 首帧快照只做基线，不回放历史工具脉冲
const slotMap = new Map();    // agentId → 星云槽位（1..12），稳定不漂移
const seenCalls = new Set();
const callStatus = new Map();
const wordState = new Map();
const seenEvents = new Set();
const askedWords = new Set();
let lastPlan = null;
const pends = [];             // 只排队真实发生过的调用动画
let suppressPends = false;    // 暂停恢复时重新对齐，不补播
let coreText = '';

function log(verb, text) {
  const d = new Date();
  logs.unshift({tm: `${pad(d.getMinutes())}:${pad(d.getSeconds())}`, verb, text});
  if (logs.length > 30) logs.pop();
  logDirty = true; capText = `${verb} · ${text}`;
}
function openFlags() { return task ? task.sections.reduce((s, x) => s + x.words.filter(w => w.state === 'flag' || w.state === 'ask').length, 0) : 0; }
function curSec() { return task && crawl.sec >= 0 && crawl.sec < task.sections.length ? task.sections[crawl.sec] : null; }
function wordPos(w, out) { const c = CL[w.ai], L = c.words[w.slot]; out = out || {}; out.x = c.x + L.lx * c.cr + L.lz * c.sr; out.z = c.z - L.lx * c.sr + L.lz * c.cr; out.y = L.y; return out; }
const cloudP = k => () => ({x: CL[k].x, y: CL[k].cy, z: CL[k].z});
function calcScore() { if (task) task.score = task.rate; }

/* 星云亮度直接跟阶段走：空闲暗、思考微亮、工具中最亮、失败偏红闪、完成偏绿 */
function applyModel(plan) {
  lastPlan = plan;
  const present = plan.agents.filter(a => !a.empty);
  for (let k = 1; k <= 12; k++) {
    const a = plan.agents[k - 1];
    if (a.empty) { AG[k].k = 'IDLE'; AG[k].zh = '待命'; AG[k].role = '—'; }
    else {
      AG[k].k = a.short; AG[k].zh = a.cjk;
      AG[k].role = a.model ? a.model : `T${a.turn}/S${a.step}`;
      AG[k].col = a.tint;                      // 标签用阶段色（原主题调色板）
    }
    loadTarget[k] = a.load;
  }
  AG[0].k = 'HOST'; AG[0].zh = 'Harness'; AG[0].role = '只读事件源';
  AG[CRAWLER].k = 'CRAWLER'; AG[CRAWLER].zh = '星云蛛'; AG[CRAWLER].role = '逐条读真实调用';

  const sections = plan.sections.map((s, si) => {
    const words = s.words.map(w => {
      const state = w.state;
      return {
        w: w.name, key: w.key, kind: w.status === 'error' ? 'vague' : 'ok',
        fix: w.status === 'error' ? ('✕ ' + (w.result || w.detail || 'error'))
          : (w.status === 'running' ? '执行中' : ('✓ ' + (w.durationMs ? Math.max(1, Math.round(w.durationMs / 100)) / 10 + 's' : (w.result || 'ok')))),
        slot: w.slot, state, status: w.status, statusText: w.status, f: state === 'idle' ? 0 : 1, sec: si, ai: s.ai, detail: w.detail,
      };
    });
    return {ai: s.ai, agentId: s.agentId, words, done: s.done, read: words.filter(x => x.state !== 'idle').length};
  });

  const counts = plan.counts;
  if (sections.length === 0) {
    task = null;
  } else {
    const path = sections.map(s => s.ai);
    task = {
      id: present.length ? ('S-' + pad(present.length)) : 'S-000',
      name: present.length ? present.map(a => a.short).slice(0, 3).join(' · ') : '无 AGENT',
      path, sections,
      base: 0, score: plan.rate, shown: task ? task.shown : plan.rate,
      rate: plan.rate, reads: sections.reduce((n, s) => n + s.read, 0),
      links: counts.ok, flags: counts.error, fixes: counts.ok + counts.error,
      total: counts.calls, t0: task ? task.t0 : simT, hist: task ? task.hist : [],
      final: task ? task.final : 0,
      vagueTotal: counts.error, awaiting: plan.awaiting,
      focusSlot: plan.focus, agentCount: present.length, allIdle: plan.idle,
      shipReady: counts.calls > 0 && counts.running === 0 && plan.awaiting === 0,
      shipMark: task ? (task.shipMark || 0) : 0,
    };
  }
  // 首帧：已有调用直接落到终态，不回放脉冲；之后只对新增/状态翻转排队。
  for (const sec of plan.sections) {
    for (const w of sec.words) {
      if (!booted) {
        seenCalls.add(w.key); wordState.set(w.key, w.state); callStatus.set(w.key, w.status);
        continue;
      }
      const isNew = !seenCalls.has(w.key);
      if (isNew) { seenCalls.add(w.key); if (!suppressPends) pends.push({kind: 'read', key: w.key, slot: sec.ai, at: simT}); }
      const prevStatus = callStatus.get(w.key);
      if (prevStatus === 'running' && w.status !== 'running' && !suppressPends) pends.push({kind: 'result', key: w.key, slot: sec.ai, at: simT});
      wordState.set(w.key, w.state);
      callStatus.set(w.key, w.status);
    }
  }
  booted = true;
  // 真实「等确认」：把该 agent 最近的 running 调用标成 ask，并让星核回一句
  for (const sec of plan.sections) {
    const agent = plan.agents[sec.ai - 1];
    if (!agent || agent.phase !== 'waiting' && agent.phase !== 'awaiting') continue;
    const w = sec.words.find(x => x.status === 'running') || sec.words[sec.words.length - 1];
    if (!w || askedWords.has(w.key)) continue;
    askedWords.add(w.key);
    if (!suppressPends) pends.push({kind: 'ask', key: w.key, slot: sec.ai, at: simT});
  }
  // 真实会话事件 → 日志 / 代码面板
  const events = Array.isArray(plan.events) ? plan.events : [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    const key = `${e.at}|${e.agentId}|${e.text}`;
    if (seenEvents.has(key)) continue;
    seenEvents.add(key);
    const verb = NC.eventVerb(e);
    const slot = slotMap.get(String(e.agentId)) || 0;
    const who = slot > 0 ? AG[slot].k.toLowerCase() : 'host';
    log(verb, `${who} · ${String(e.text || '').slice(0, 46)}`);
    codeChars = Math.max(0, codeChars - 60);
    codeHL = 1;
    if (verb === 'walk') { /* 事件不驱动拓扑位移 */ }
  }
  for (let k = 1; k <= 12; k++) if (plan.agents[k - 1] && !plan.agents[k - 1].empty) load[k] = Math.max(load[k], 0.05);
}

function setSnapshot(next) {
  if (!next || typeof next !== 'object') return;
  if (bootAt === 0) bootAt = Date.now();
  snap = next;
  const slotsBefore = new Map(slotMap);
  const plan = NC.planSnapshot(next, {slots: slotsBefore, states: wordState});
  slotMap.clear(); plan.slotMap.forEach((v, k) => slotMap.set(k, v));
  applyModel(plan);
}
function setTransport(state) { transport = String(state || 'connecting'); }
function setPaused(next) { paused = next === true; }
function setWaiting(next) { quiet = next === true; }

function statusLine() {
  if (transport === 'denied') return 'AUTH 401';
  if (transport === 'offline') return 'OFFLINE';
  if (paused) return 'PAUSED';
  if (snap === null) return 'WAITING';
  if (task === null || task.agentCount === 0) return 'NO AGENT';
  if (quiet) return 'SILENT';
  return 'LISTENING';
}

function readWord(w) {
  w.state = 'read'; w.f = 1;
  if (task) { task.reads = task.sections.reduce((n, s) => n + s.words.filter(x => x.state !== 'idle').length, 0); }
  wordsToday++;
  readTimes.push(simT);
  threadTo(w);
  later(.06, () => flyChip(w, 'read'));
  log('read', `${AG[w.ai].k.toLowerCase()} · ${w.w}`);
  flash[w.ai] += .18;
}
function resultWord(w) {
  if (!w) return;
  const bad = w.state === 'flag' || w.kind === 'vague';
  w.state = bad ? 'flag' : 'fix'; w.f = 1;
  flash[w.ai] += bad ? .6 : .35;
  flyChip(w, bad ? 'flag' : 'fix');
  comet(wordPos(w), cloudP(w.ai), bad ? '#ff6f8b' : '#6ff0c0', .42, .34);
  log(bad ? 'flag' : 'fix', `${w.w} ${bad ? '✕' : '✓'} ${String(w.fix).replace(/^[✓✕]\s*/u, '').slice(0, 24)}`);
  if (!bad) fixesToday++;
}
function askWord(w) {
  if (!w) return;
  w.state = 'ask'; w.f = 1;
  comet(wordPos(w), CORE_P, '#ff6fae', .5, .42, () => { flash[0] += .5; coreSay = {t: 1.6, txt: 'WAIT · 等确认'}; });
  log('ask', `${w.w} · 等待确认`);
}

function consumePend() {
  const s = curSec();
  if (!s) return false;
  for (let i = pends.length - 1; i >= 0; i--) {
    const p = pends[i];
    if (simT - p.at > 8) { pends.splice(i, 1); continue; }
    if (p.slot !== s.ai) continue;
    pends.splice(i, 1);
    const w = s.words.find(x => x.key === p.key);
    if (!w) continue;
    if (p.kind === 'read') readWord(w); else if (p.kind === 'result') resultWord(w); else askWord(w);
    return true;
  }
  return false;
}

function startRead() { crawl.phase = 'read'; crawl.wi = 0; crawl.wt = .12; const s = curSec(); if (s) flash[s.ai] += .4; }
/* 真实「调用中」的工具节点保持连线，而不是只在读词一瞬间闪一下 */
function threadRunning(s) {
  if (!s) return;
  for (const w of s.words) {
    if (w.status === 'running' && !threads.some(t => t.on && !t.ret && t.w === w)) threadTo(w);
  }
}
const CORE_TOP = {x: 0, y: CORE_Y + 6.2, z: 0};
function deliverFx() {
  if (!task) return;
  const t = task;
  [['.p-score', `✓ ${t.final}%<i>成功率</i>`], ['.p-sec', `→ ${t.sections.length} AGENT<i>本轮</i>`], ['.p-log', `${t.id}<i>事件已同步</i>`], ['.p-rad', `✓ LIVE<i>只读</i>`], ['.p-heat', `${t.total} 调用<i>已记录</i>`], ['.p-code', `settle()<i>ok</i>`]]
    .forEach(([sel, html], i) => later(.3 + i * .1, () => flyFrom(CORE_TOP, html, '#6ff0c0', sel, true)));
  later(.12, () => { if (spider.a === 0 && !spider.air) { walkTo({a: 0, lx: spider.lx, lz: spider.lz}, null, true); spider.jump.h = .55; spider.jump.dur = .42; } });
  later(.75, () => { if (spider.a === 0 && !spider.air) { walkTo({a: 0, lx: spider.lx, lz: spider.lz}, null, true); spider.jump.h = .35; spider.jump.dur = .32; } });
}

/* 每帧：只根据真实状态推进星云蛛，不再有任何随机业务流水 */
function dataStep(dt) {
  simT += dt; orbT += dt; orbitStep();
  for (let i = jobs.length - 1; i >= 0; i--) if (jobs[i].t <= simT) { const j = jobs[i]; jobs.splice(i, 1); j.fn(); }
  for (let k = 1; k <= 12; k++) load[k] += (loadTarget[k] - load[k]) * Math.min(1, dt * 3);
  const want = statusLine();
  if (coreSay.t <= 0 && coreText !== want) { coreText = want; coreSay = {t: 1.1, txt: want}; }
  if (task) { calcScore(); task.shown += (task.score - task.shown) * Math.min(1, dt * 3); if ((task.hist.length === 0 || simT - task.hist.at(-1)[0] > .5) && crawl.phase !== 'rest') task.hist.push([simT, task.shown]); }

  if (crawl.phase === 'brief') {
    crawl.t += dt;
    if (!crawl.stroll && !spider.air && spider.a === 0 && crawl.t > .25) { crawl.stroll = 1; walkTo({a: 0, lx: rnd(-1.8, 1.8), lz: rnd(2.2, 3.8)}); }
    if (crawl.t > 1.2 && !spider.walking && !spider.air) {
      const s = targetSection();
      if (s >= 0) { crawl.stroll = 0; crawl.sec = s; crawl.phase = 'walk'; walkTo(standOf(task.sections[s].ai), () => startRead(), true); log('walk', `→ ${AG[task.sections[s].ai].k.toLowerCase()}`); }
    }
  } else if (crawl.phase === 'read') {
    if (spider.walking || spider.air) { spiderMove(dt); cometStep(dt); return; }
    // 焦点 agent 变了 → 跳过去（真实活动位置变化，不是虚构派单）
    const s = targetSection();
    if (s >= 0 && s !== crawl.sec && task) { crawl.sec = s; crawl.phase = 'walk'; walkTo(standOf(task.sections[s].ai), () => startRead(), true); log('walk', `→ ${AG[task.sections[s].ai].k.toLowerCase()}`); spiderMove(dt); cometStep(dt); return; }
    crawl.wt -= dt;
    crawl.tth = (crawl.tth || 0) + dt;
    if (crawl.tth > .2) { crawl.tth = 0; threadRunning(curSec()); }
    if (crawl.wt <= 0) {
      if (consumePend()) crawl.wt = .26;
      else if (task && task.shipReady && task.shipMark !== task.reads) {
        crawl.phase = 'ship'; crawl.t = 0;
      } else {
        // 真实调用仍在跑：在云面上挪一小段，等下一个事件
        crawl.wt = .35;
        crawl.idleW = (crawl.idleW || 0) + .35;
        if (crawl.idleW > 2.6 && task) { crawl.idleW = 0; const c = curSec(); const cc = c && CL[c.ai]; if (cc && !spider.air) walkTo({a: c.ai, lx: rnd(-cc.R * .4, cc.R * .4), lz: rnd(-cc.R * .32, cc.R * .32)}); }
      }
    }
  } else if (crawl.phase === 'ship') {
    crawl.t += dt;
    if (!crawl.ship) {
      if (!task) { crawl.phase = 'rest'; crawl.t = 0; }
      else {
        task.final = Math.round(task.rate);
        task.shipMark = task.reads;
        crawl.ship = 1; shipPulse.on = true; shipPulse.d = 0; flash[0] += 1.2;
        coreSay = {t: 3, txt: `DONE ✓ ${task.final}%`};
        deliverFx(); shipped += task.sections.reduce((n, s) => n + s.words.length, 0);
        log('ship', `${task.id} · ${task.total} 调用 · 成功率 ${task.final}%`);
      }
    } else if (!shipPulse.on) {
      crawl.phase = 'rest'; crawl.t = 0; scoreHist.push(task ? task.final : 0); if (scoreHist.length > 24) scoreHist.shift();
    }
  } else if (crawl.phase === 'rest') {
    trailFade = Math.max(0, 1 - crawl.t / 1.0);
    if (task) task.sections.forEach(s => s.words.forEach(w => { w.f = Math.max(0, w.f - dt * 1.3); }));
    crawl.t += dt;
    if (crawl.t > 1.1) { crawl.phase = 'brief'; crawl.t = 0; crawl.sec = -1; crawl.ship = 0; retractThreads(); }
  }

  spiderMove(dt);
  cometStep(dt);
  while (readTimes.length && simT - readTimes[0] > 6) readTimes.shift();
}
function targetSection() {
  if (!task) return -1;
  if (task.focusSlot <= 0) return -1;
  return task.sections.findIndex(s => s.ai === task.focusSlot);
}
/* ---------- 星云蛛：趴在云顶上扒来扒去，读完一团再跳到下一团；位置记在所在星云的局部坐标里，跟着星云一起公转 ---------- */
const spider = {a: 0, lx: REST.lx, lz: REST.lz, x: 0, y: 0, z: 0, head: Math.PI, vx: 0, vz: 0, dx: 0, dz: 0, path: null, d: 0, jump: null, onArrive: null, walking: false, air: false, bob: 0, land: 0, n: [0, 1, 0]};
{ const p = anchorW(0, REST.lx, REST.lz); spider.x = p.x; spider.y = p.y; spider.z = p.z; }
const trail = []; let trailFade = 1;           // 丝线：{a, lx, lz} 贴在云面上的点，或 {j, u} 跳跃弧线上的点
const shipPulse = {on: false, d: 0};
const _p0 = {}, _p1 = {};
function jumpAt(J, u, o){ anchorW(J.a0, J.l0x, J.l0z, _p0); anchorW(J.a1, J.l1x, J.l1z, _p1); const e = lerp(u, u * u * (3 - 2 * u), .3); o.x = lerp(_p0.x, _p1.x, e); o.z = lerp(_p0.z, _p1.z, e); o.y = lerp(_p0.y, _p1.y, u) + 4 * J.h * u * (1 - u); return o; }
function trailAt(e, o){ return e.j ? jumpAt(e.j, e.u, o) : anchorW(e.a, e.lx, e.lz, o); }
// jump = 跨星云的大跳（越远跳得越高、越久，最长不到 1 秒）；否则在当前这团星云 / 星核上爬一小段弯路
function walkTo(tg, cb, jump){
  spider.onArrive = cb || null;
  if (jump || tg.a !== spider.a) {
    const p1 = anchorW(tg.a, tg.lx, tg.lz), L = Math.hypot(p1.x - spider.x, p1.z - spider.z);
    spider.jump = {a0: spider.a, l0x: spider.lx, l0z: spider.lz, a1: tg.a, l1x: tg.lx, l1z: tg.lz, h: Math.min(6, 1.4 + L * .2), t: 0, dur: clamp(.38 + L * .02, .42, .95)};
    spider.air = true; spider.walking = false;
    if (crawl.phase !== 'brief' && crawl.phase !== 'rest' && crawl.phase !== 'ship') trail.push({j: spider.jump, u: 0});
  } else {
    const x0 = spider.lx, z0 = spider.lz, dx = tg.lx - x0, dz = tg.lz - z0, L = Math.hypot(dx, dz) || 1;
    const side = Math.random() < .5 ? -1 : 1, bend = L * rnd(.12, .3) * side;
    const cx = (x0 + tg.lx) / 2 - dz / L * bend, cz = (z0 + tg.lz) / 2 + dx / L * bend, pts = [], cum = [0];
    for (let i = 0; i <= 48; i++) { const u = i / 48, a = (1 - u) * (1 - u), b = 2 * u * (1 - u), c = u * u; pts.push([a * x0 + b * cx + c * tg.lx, a * z0 + b * cz + c * tg.lz]); if (i) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])); }
    spider.path = {pts, cum, L: cum[48]}; spider.d = 0; spider.walking = true;
  }
}
function pathAt(P, d){ let i = 1; while (i < 48 && P.cum[i] < d) i++; const u = (d - P.cum[i - 1]) / Math.max(1e-6, P.cum[i] - P.cum[i - 1]); return [lerp(P.pts[i - 1][0], P.pts[i][0], u), lerp(P.pts[i - 1][1], P.pts[i][1], u)]; }
function arrive(){ const cb = spider.onArrive; spider.onArrive = null; cb && cb(); }
const _sp = {};
function spiderMove(dt){
  const ox = spider.x, oz = spider.z;
  spider.dx = spider.dz = 0;
  if (spider.jump) {
    const J = spider.jump; J.t += dt / J.dur; const u = Math.min(1, J.t);
    jumpAt(J, u, _sp); spider.x = _sp.x; spider.y = _sp.y; spider.z = _sp.z;
    const last = trail[trail.length - 1];
    if (last && last.j === J && u - last.u > .04) trail.push({j: J, u});
    if (u >= 1) { spider.jump = null; spider.air = false; spider.a = J.a1; spider.lx = J.l1x; spider.lz = J.l1z; spider.land = 1; arrive(); }
  } else {
    // 星云在公转：这一帧星云带着它挪了多少（脚也要跟着挪）
    anchorW(spider.a, spider.lx, spider.lz, _sp); spider.dx = _sp.x - ox; spider.dz = _sp.z - oz;
    if (spider.walking) {
      const P = spider.path, v = 3.8 * clamp(Math.min(spider.d + .35, P.L - spider.d + .3) / .9, .3, 1);
      spider.d = Math.min(P.L, spider.d + v * dt); [spider.lx, spider.lz] = pathAt(P, spider.d);
      if (spider.d >= P.L) { spider.walking = false; arrive(); }
    }
    anchorW(spider.a, spider.lx, spider.lz, _sp); spider.x = _sp.x; spider.y = _sp.y; spider.z = _sp.z;
    const last = trail[trail.length - 1];
    if (crawl.phase !== 'rest' && crawl.phase !== 'brief' && crawl.phase !== 'ship' && (!last || last.j || last.a !== spider.a || Math.hypot(last.lx - spider.lx, last.lz - spider.lz) > .3)) trail.push({a: spider.a, lx: spider.lx, lz: spider.lz});
  }
  spider.land *= Math.exp(-dt * 7);
  spider.vx = (spider.x - ox - spider.dx) / Math.max(dt, 1e-4); spider.vz = (spider.z - oz - spider.dz) / Math.max(dt, 1e-4);
  const sp = Math.hypot(spider.vx, spider.vz);
  let want = spider.head;
  if (sp > .3) want = Math.atan2(spider.vx, spider.vz);
  else if (crawl.phase === 'read') { const s = curSec(), w = s && s.words[Math.max(0, crawl.wi - 1)]; if (w) { const p = wordPos(w); want = Math.atan2(p.x - spider.x, p.z - spider.z); } }
  else if (crawl.phase === 'ship' || crawl.phase === 'brief' || crawl.phase === 'rest') want = Math.PI;
  spider.head = angLerp(spider.head, want, Math.min(1, dt * (spider.air ? 9 : sp > .3 ? 6 : 4)));
  spider.bob += dt * (spider.walking ? 12 : 2.2);
  // 身体顺着云面 / 球面倾斜
  if (!spider.air) { const c = CL[spider.a], e = .35, h0 = surfW(c, spider.x, spider.z), hx = surfW(c, spider.x + e, spider.z), hz = surfW(c, spider.x, spider.z + e);
    let nx = -(hx - h0) / e, nz = -(hz - h0) / e; const nl = Math.hypot(nx, 1, nz); spider.n[0] += (nx / nl - spider.n[0]) * Math.min(1, dt * 8); spider.n[1] += (1 / nl - spider.n[1]) * Math.min(1, dt * 8); spider.n[2] += (nz / nl - spider.n[2]) * Math.min(1, dt * 8); }
  else { spider.n[0] *= .9; spider.n[2] *= .9; spider.n[1] += (1 - spider.n[1]) * .1; }
  if (shipPulse.on) { shipPulse.d += dt; if (shipPulse.d >= 2.4) shipPulse.on = false; }
}
let trailLenW = 0;

/* ---------- 流星：交接 / 提问 / 回答 / 连线 ---------- */
const CORE_P = {x: 0, y: CORE_Y, z: 0};
const comets = [];
function comet(a, b, col, dur, size, cb){ comets.push({a, b, col, dur, size, t: 0, cb}); }
function cometAt(c, u, o){
  const A = typeof c.a === 'function' ? c.a() : c.a, B = typeof c.b === 'function' ? c.b() : c.b, L = Math.hypot(B.x - A.x, B.z - A.z);
  const my = Math.max(A.y, B.y) + Math.min(4, L * .22), a = (1 - u) * (1 - u), b = 2 * u * (1 - u), d = u * u;
  o.x = a * A.x + b * (A.x + B.x) / 2 + d * B.x; o.y = a * A.y + b * my + d * B.y; o.z = a * A.z + b * (A.z + B.z) / 2 + d * B.z; return o;
}
function cometStep(dt){ for (let i = comets.length - 1; i >= 0; i--) { const c = comets[i]; c.t += dt / c.dur; if (c.t >= 1) { comets.splice(i, 1); c.cb && c.cb(); } } }
let coreSay = {t: 0, txt: ''};

/* ================= 4. 3D 星云 ================= */
const THREE = window.THREE;
const cv = $('#gl');
let renderer = null, scene, camera, composer = null, bloom = null, world, glOK = false, pr = 1;
const U = {time: {value: 0}, px: {value: 600}, b: {value: new Float32Array(16).fill(1)}, sp: {value: null}};
let starsObj, threadObj, sparkObj, trailLine, coreBall, abdBall, legG, ringsG, streakG, cometSprites = [], pulseSpr, GLOW;
const legs = [];
const v3 = window.THREE ? new THREE.Vector3() : null;

const PT_VS = `attribute vec3 aCol; attribute float aSize; attribute float aPh; attribute float aCid;
uniform float uTime, uPx; uniform float uB[16]; uniform vec4 uSp;
varying vec3 vCol; varying float vA;
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.);
  gl_Position = projectionMatrix * mv;
  float tw = .62 + .38 * sin(uTime * (1.1 + aPh * .9) + aPh * 37.);
  float pk = 1.;
  if (aCid < 12.5) { vec4 wp = modelMatrix * vec4(position, 1.); pk = mix(.16, 1., smoothstep(uSp.w * .45, uSp.w * 1.5, length(wp.xz - uSp.xz))); }
  vA = tw * uB[int(aCid + .5)] * pk;
  vCol = aCol;
  gl_PointSize = max(1., aSize * uPx / -mv.z);
}`;
const PT_FS = `varying vec3 vCol; varying float vA;
void main(){ vec2 c = gl_PointCoord - .5; float d = dot(c, c); if (d > .25) discard; float a = smoothstep(.25, .0, d); gl_FragColor = vec4(vCol, a * a * vA); }`;
const RB_VS = `attribute vec2 aUV; attribute vec3 aNrm; uniform float uTime, uPh, uAmp; varying vec2 vUV;
void main(){ vec3 p = position + aNrm * sin(aUV.x * 18.85 + uTime * 1.5 + uPh) * uAmp; vUV = aUV; gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.); }`;
const RB_FS = `uniform vec3 uC1, uC2; uniform float uTime, uPh, uA; varying vec2 vUV;
void main(){
  float e = abs(vUV.y * 2. - 1.);
  float edge = pow(e, 5.) * 1.1 + .14;
  float str = .5 + .5 * sin(vUV.y * 70. + vUV.x * 30.);
  float along = .25 + .75 * pow(.5 + .5 * sin(vUV.x * 12.566 + uTime * .6 + uPh), 2.);
  vec3 col = mix(uC1, uC2, .5 + .5 * sin(vUV.x * 6.2832 * 2. + uPh));
  gl_FragColor = vec4(col, edge * (.55 + .45 * str) * along * uA);
}`;
const LEG_VS = `varying vec3 vN; varying vec3 vV; void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`;
const LEG_FS = `uniform vec3 uC; uniform float uA; varying vec3 vN; varying vec3 vV; void main(){ float f = 1. - abs(dot(vN, vV)); gl_FragColor = vec4(uC, (pow(f, 2.2) * .95 + .1) * uA); }`;
const ST_VS = `attribute float aA; attribute float aPh; attribute float aY; uniform float uTime; varying float vA; varying float vY;
void main(){ vA = aA * (.45 + .55 * sin(uTime * (.35 + aPh * .5) + aPh * 40.)); vY = aY; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`;
const ST_FS = `uniform vec3 uC; varying float vA; varying float vY; void main(){ float f = 1. - abs(vY * 2. - 1.); gl_FragColor = vec4(uC, vA * f * f); }`;

function ptMat(){ return new THREE.ShaderMaterial({uniforms: {uTime: U.time, uPx: U.px, uB: U.b, uSp: U.sp}, vertexShader: PT_VS, fragmentShader: PT_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending}); }
function pointsObj(n){
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  g.setAttribute('aCol', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  g.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(n), 1));
  g.setAttribute('aPh', new THREE.BufferAttribute(new Float32Array(n), 1));
  g.setAttribute('aCid', new THREE.BufferAttribute(new Float32Array(n), 1));
  const p = new THREE.Points(g, ptMat()); p.frustumCulled = false; return p;
}
function setPt(o, i, x, y, z, c, s, cid){ const g = o.geometry.attributes; g.position.setXYZ(i, x, y, z); g.aCol.setXYZ(i, c[0], c[1], c[2]); g.aSize.setX(i, s); g.aPh.setX(i, rng()); g.aCid.setX(i, cid); }
const mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const WHITE = [1, 1, 1], ICE = hex3('#9fd4ff'), PEACH = hex3('#ffb48f');
function canvasTex(w, h, draw){ const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h); const t = new THREE.CanvasTexture(c); t.needsUpdate = true; return t; }

/* ---------- 12 团星云（每团一个组，跟着公转）+ 星核尘埃 + 轨道 ---------- */
const cloudG = [], hazes = [];
// 六种星云形态轮流分给 12 团，相邻的不重样：
// puff 蓬松团云 · swirl 旋涡（两三条旋臂）· ring 环状星云（中间空）· stream 彗尾流（顺着轨道拖尾巴）· twin 双瓣（蝴蝶状）· fiber 纤维丝团
const STYLES = ['puff', 'swirl', 'ring', 'stream', 'twin', 'fiber'];
const STYLE_OF = [null, 'swirl', 'ring', 'puff', 'stream', 'twin', 'fiber', 'ring', 'puff', 'swirl', 'fiber', 'stream', 'twin'];
function buildNebulae(){
  const ND = 1600;
  const HAZE = canvasTex(128, 128, (x, w) => { const g = x.createRadialGradient(64, 64, 0, 64, 64, 64); g.addColorStop(0, 'rgba(255,255,255,.9)'); g.addColorStop(.35, 'rgba(255,255,255,.38)'); g.addColorStop(.7, 'rgba(255,255,255,.08)'); g.addColorStop(1, 'rgba(255,255,255,0)'); x.fillStyle = g; x.fillRect(0, 0, w, w); });
  for (let k = 1; k <= 12; k++) {
    const c = CL[k], col = AGC[k], R = c.R, st = STYLE_OF[k], grp = new THREE.Group(); world.add(grp); cloudG[k] = grp; c.style = st;
    const N = st === 'fiber' ? 1900 : 3400, NF = st === 'fiber' ? 150 : st === 'puff' ? 50 : 26, FP = 46;
    const pts = pointsObj(N + NF * FP); let i = 0;
    const arms = 2 + (rng() < .5 ? 1 : 0), spin = rng() < .5 ? 1 : -1, a0 = rng() * TAU;
    const lobes = st === 'twin' ? [{x: -R * .55, z: (rng() - .5) * R * .2, r: R * .46}, {x: R * .55, z: (rng() - .5) * R * .2, r: R * .42}]
      : Array.from({length: 4}, () => { const a = rng() * TAU, rr = R * rng() * .4; return {x: Math.cos(a) * rr * 1.1, z: Math.sin(a) * rr * .8, r: R * (.38 + rng() * .22)}; });
    // 每种形态的光雾位置
    const hz = st === 'ring' ? Array.from({length: 6}, (_, q) => { const a = q / 6 * TAU; return {x: Math.cos(a) * R * .62 * 1.1, z: Math.sin(a) * R * .62 * .8, r: R * .34}; })
      : st === 'stream' ? [{x: R * .5, z: 0, r: R * .42}, {x: -R * .1, z: 0, r: R * .36}, {x: -R * .7, z: 0, r: R * .28}]
      : st === 'swirl' ? [{x: 0, z: 0, r: R * .3}, {x: 0, z: 0, r: R * .75}]
      : st === 'fiber' ? [{x: 0, z: 0, r: R * .85}]
      : lobes.concat([{x: 0, z: 0, r: R * .8}]);
    hz.forEach((L, q) => {
      const h = new THREE.Sprite(new THREE.SpriteMaterial({map: HAZE, color: new THREE.Color(...mix3(col, WHITE, .12)), transparent: true, opacity: st === 'fiber' ? .06 : .08, blending: THREE.AdditiveBlending, depthWrite: false}));
      h.position.set(L.x, c.y0 + c.top * .4, L.z); h.scale.setScalar(L.r * 2.4); h.userData.k = k; h.userData.o = h.material.opacity; grp.add(h); hazes.push(h);
    });
    for (let n = 0; n < N; n++, i++) {
      let x, z, br = 1;
      if (st === 'swirl') {
        if (rng() < .22) { x = gauss() * R * .16; z = gauss() * R * .13; br = 1.25; }
        else { const t = Math.pow(rng(), .8), a = a0 + ((n % arms) / arms) * TAU + spin * t * 3.4, rr = R * (.12 + .86 * t), wd = R * (.13 - .07 * t); x = Math.cos(a) * rr * 1.1 + gauss() * wd; z = Math.sin(a) * rr * .82 + gauss() * wd; br = 1.1 - t * .4; }
      } else if (st === 'ring') {
        if (rng() < .1) { x = gauss() * R * .25; z = gauss() * R * .2; br = .6; }
        else { const a = rng() * TAU, rr = R * (.64 + gauss() * .08); x = Math.cos(a) * rr * 1.1; z = Math.sin(a) * rr * .8; br = .9 + .3 * Math.max(0, Math.cos(a - a0)); }
      } else if (st === 'stream') {
        const t = Math.pow(rng(), 1.3), wd = R * (.34 * (1 - t) + .06); x = R * (.75 - 1.85 * t) + gauss() * R * .06; z = gauss() * wd + Math.sin(t * 5 + a0) * R * .12 * t; br = 1.15 - t * .55;
      } else if (st === 'fiber') {
        x = gauss() * R * .5; z = gauss() * R * .38; br = .7;
      } else {
        const L = lobes[(rng() * lobes.length) | 0]; x = L.x + gauss() * L.r * .58; z = L.z + gauss() * L.r * (st === 'twin' ? .62 : .5);
        if (st === 'twin' && rng() < .08) { x = gauss() * R * .1; z = gauss() * R * .3; br = 1.3; }   // 两瓣之间的腰
      }
      const top = surfL(c, x, z), y = c.y0 - .35 + (top - c.y0 + .35) * Math.pow(rng(), .5) + gauss() * .06, w = Math.pow(rng(), 3.5);
      setPt(pts, i, x, y, z, mix3(col, WHITE, w * .8).map(v => v * Math.min(1.2, (.5 + rng() * .5) * br)), .045 + Math.pow(rng(), 9) * .34 + w * .05, k);
    }
    for (let f = 0; f < NF; f++) {
      let x0, z0, dir;
      if (st === 'ring') { const a = rng() * TAU; x0 = Math.cos(a) * R * .64 * 1.1; z0 = Math.sin(a) * R * .64 * .8; dir = a + HP + (rng() - .5) * .5; }
      else if (st === 'stream') { x0 = R * (.6 - 1.5 * rng()); z0 = (rng() - .5) * R * .4; dir = (rng() - .5) * .35; }
      else if (st === 'swirl') { const t = rng(), a = a0 + ((f % arms) / arms) * TAU + spin * t * 3.4, rr = R * (.15 + .8 * t); x0 = Math.cos(a) * rr * 1.1; z0 = Math.sin(a) * rr * .82; dir = a + spin * HP; }
      else { x0 = (rng() - .5) * R * 1.4; z0 = (rng() - .5) * R * .9; dir = (rng() - .5) * (st === 'fiber' ? TAU : 1.8); }
      const len = R * (st === 'fiber' ? .4 + rng() * 1.1 : .4 + rng() * .7), amp = R * (.05 + rng() * .12), fr = 2 + rng() * 4, ph = rng() * TAU, hf = .55 + rng() * .45;
      const cc0 = mix3(col, WHITE, .25 + rng() * .4);
      for (let q = 0; q < FP; q++, i++) {
        const u = q / (FP - 1) - .5, bend = Math.sin(u * fr + ph) * amp;
        const x = x0 + Math.cos(dir) * u * len - Math.sin(dir) * bend, z = z0 + Math.sin(dir) * u * len * .6 + Math.cos(dir) * bend * .6;
        const y = c.y0 + (surfL(c, x, z) - c.y0) * hf + Math.sin(u * 5 + ph) * .15, fade = 1 - Math.abs(u) * 1.6;
        setPt(pts, i, x + gauss() * .03, y, z + gauss() * .03, cc0.map(v => v * ((st === 'fiber' ? .55 : .4) + .55 * Math.max(0, fade))), .04 + rng() * .03, k);
      }
    }
    grp.add(pts);
  }
  // 三条公转轨道：细线 + 沿轨道散开的一层淡尘埃
  const NO = 900, od = pointsObj(NO * 3 + ND); let i = 0;
  ORBITS.forEach((o, oi) => {
    const P = []; for (let j = 0; j <= 240; j++) { const f = j / 240 * TAU; P.push(new THREE.Vector3(Math.cos(f) * o.ax, -.35, Math.sin(f) * o.az)); }
    world.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(P), new THREE.LineBasicMaterial({color: oi === 1 ? 0xffc2a6 : 0x9fd4ff, transparent: true, opacity: .2, blending: THREE.AdditiveBlending, depthWrite: false})));
    for (let n = 0; n < NO; n++, i++) { const f = rng() * TAU, j = 1 + gauss() * .035; const cc = (rng() < .3 ? PEACH : rng() < .5 ? ICE : WHITE).map(v => v * (.25 + rng() * .4)); setPt(od, i, Math.cos(f) * o.ax * j, -.35 + gauss() * .15, Math.sin(f) * o.az * j, cc, .035 + Math.pow(rng(), 8) * .18, 13); }
  });
  for (let n = 0; n < ND; n++, i++) {
    const a = rng() * TAU, r = 6.2 + Math.abs(gauss()) * 3.2;
    const cc = (rng() < .3 ? PEACH : rng() < .5 ? ICE : WHITE).map(v => v * (.4 + rng() * .5));
    setPt(od, i, Math.cos(a) * r * 1.15, gauss() * .35 + .4, Math.sin(a) * r * .8, cc, .04 + Math.pow(rng(), 6) * .22, 0);
  }
  world.add(od);
  // 远处星空：平面下方一层 + 上方稀疏一层
  const NS = 2600; starsObj = pointsObj(NS);
  for (let n = 0; n < NS; n++) {
    const up = rng() < .18, cc = (rng() < .25 ? PEACH : rng() < .5 ? ICE : WHITE).map(v => v * (.35 + rng() * .65));
    setPt(starsObj, n, (rng() - .5) * 170, up ? 6 + rng() * 14 : -6 - rng() * 26, (rng() - .5) * 110, cc, .08 + Math.pow(rng(), 8) * .9, 13);
  }
  world.add(starsObj);
}

/* ---------- 丝带星核（图三那种发光丝带缠成的球）：星核和蜘蛛腹部共用 ---------- */
function ribbonMat(c1, c2, amp, alpha){ return new THREE.ShaderMaterial({uniforms: {uTime: U.time, uPh: {value: rng() * TAU}, uAmp: {value: amp}, uC1: {value: new THREE.Color(c1)}, uC2: {value: new THREE.Color(c2)}, uA: {value: alpha}}, vertexShader: RB_VS, fragmentShader: RB_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide}); }
function ribbonGeo(R, w0, seg){
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rng() * TAU, rng() * TAU, rng() * TAU));
  const p1 = rng() * TAU, p2 = rng() * TAU, k1 = 2 + ((rng() * 2) | 0);
  const P = [];
  for (let i = 0; i <= seg; i++) { const u = i / seg * TAU; const rr = R * (1 + .14 * Math.sin(3 * u + p1)); const v = new THREE.Vector3(Math.cos(u) * rr, R * .22 * Math.sin(k1 * u + p2), Math.sin(u) * rr).applyQuaternion(q); P.push(v); }
  const pos = new Float32Array((seg + 1) * 6), uv = new Float32Array((seg + 1) * 4), nrm = new Float32Array((seg + 1) * 6), idx = [];
  const T = new THREE.Vector3(), N = new THREE.Vector3(), B = new THREE.Vector3();
  for (let i = 0; i <= seg; i++) {
    const a = P[(i + seg - 1) % seg], b = P[(i + 1) % seg], p = P[i];
    T.subVectors(b, a).normalize(); N.copy(p).normalize(); B.crossVectors(T, N).normalize();
    const u = i / seg, w = w0 * (.25 + .75 * Math.pow(.5 + .5 * Math.sin(u * TAU * 2 + p1), 1.5));
    for (let s = 0; s < 2; s++) { const sg = s ? .5 : -.5, o = (i * 2 + s); pos[o * 3] = p.x + B.x * w * sg; pos[o * 3 + 1] = p.y + B.y * w * sg; pos[o * 3 + 2] = p.z + B.z * w * sg; uv[o * 2] = u; uv[o * 2 + 1] = s; nrm[o * 3] = N.x; nrm[o * 3 + 1] = N.y; nrm[o * 3 + 2] = N.z; }
    if (i < seg) { const o = i * 2; idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('aUV', new THREE.BufferAttribute(uv, 2)); g.setAttribute('aNrm', new THREE.BufferAttribute(nrm, 3)); g.setIndex(idx);
  return g;
}
function makeRibbonBall(R, n, w0, seg, amp, alpha){
  const g = new THREE.Group(), PAL = [['#d9ecff', '#7fb6ff'], ['#ffffff', '#ffc2a6'], ['#9fd4ff', '#ffffff'], ['#ffb48f', '#d9ecff'], ['#7aa8ff', '#e6f2ff']];
  for (let i = 0; i < n; i++) { const [c1, c2] = PAL[i % PAL.length]; const m = new THREE.Mesh(ribbonGeo(R * (.82 + rng() * .3), w0 * (.6 + rng() * .8), seg), ribbonMat(c1, c2, amp, alpha * (.6 + rng() * .5))); m.frustumCulled = false; m.userData.ax = new THREE.Vector3(rng() - .5, rng() - .5, rng() - .5).normalize(); m.userData.sp = (rng() - .5) * .5; g.add(m); }
  return g;
}
function buildCore(){
  coreBall = makeRibbonBall(6.1, 24, 1.7, 220, .22, .66); coreBall.position.set(0, CORE_Y, 0); world.add(coreBall);
  // 星核外的几圈轨道椭圆（图三的元素），上面有光点在跑
  ringsG = new THREE.Group(); ringsG.position.copy(coreBall.position); world.add(ringsG);
  [[8.0, .35, .1], [9.4, -.28, -.18], [10.6, .16, .26]].forEach(([r, rx, rz], i) => {
    const pts = []; for (let j = 0; j <= 160; j++) { const a = j / 160 * TAU; pts.push(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r)); }
    const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({color: i === 1 ? 0xffc2a6 : 0x9fd4ff, transparent: true, opacity: .22, blending: THREE.AdditiveBlending, depthWrite: false}));
    const holder = new THREE.Group(); holder.rotation.set(rx, 0, rz); holder.add(line);
    const dot = new THREE.Sprite(new THREE.SpriteMaterial({map: GLOW, color: i === 1 ? 0xffd0b8 : 0xcfe6ff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false})); dot.scale.setScalar(.55); holder.add(dot);
    holder.userData = {r, dot, sp: [.35, -.22, .16][i]}; ringsG.add(holder);
  });
}
/* ---------- 背景竖向光丝（图三里那种从上到下的细光线），贴在镜头上 ---------- */
function buildStreaks(){
  const n = 140, pos = [], aA = [], aPh = [], aY = [], idx = [];
  for (let i = 0; i < n; i++) {
    const x = rng() * 2 - 1, w = .0008 + Math.pow(rng(), 3) * .0026, h = .3 + rng() * 1.5, y = (rng() - .5) * 1.4, a = .08 + Math.pow(rng(), 2) * .4, ph = rng(), o = i * 4;
    pos.push(x - w, y - h / 2, 0, x + w, y - h / 2, 0, x + w, y + h / 2, 0, x - w, y + h / 2, 0);
    for (let q = 0; q < 4; q++) { aA.push(a); aPh.push(ph); }
    aY.push(0, 0, 1, 1); idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('aA', new THREE.Float32BufferAttribute(aA, 1)); g.setAttribute('aPh', new THREE.Float32BufferAttribute(aPh, 1)); g.setAttribute('aY', new THREE.Float32BufferAttribute(aY, 1)); g.setIndex(idx);
  const m = new THREE.Mesh(g, new THREE.ShaderMaterial({uniforms: {uTime: U.time, uC: {value: new THREE.Color('#8fb8ff')}}, vertexShader: ST_VS, fragmentShader: ST_FS, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending}));
  m.frustumCulled = false; m.renderOrder = -10;
  streakG = new THREE.Group(); streakG.position.z = -100; streakG.add(m); camera.add(streakG);
}

/* ---------- 星云蛛（图二）：粒子头 + 两只大圆眼 + 丝带星云腹部 + 8 条半透明腿 ---------- */
const HEAD = new (window.THREE ? THREE.Vector3 : Object)(0, 1.0, .55);
function buildSpider(){
  const g = new THREE.Group(); world.add(g); spider.g = g; g.scale.setScalar(S);
  const HR = .72, AR = 1.38, AC = [0, 1.32, -1.25];
  // 身体里垫一层深色实心球：让粒子像长在一个实体上，也挡住身后的星云
  const dark = new THREE.MeshBasicMaterial({color: 0x050a1a});
  const hd = new THREE.Mesh(new THREE.SphereGeometry(HR * .8, 24, 18), dark); hd.position.copy(HEAD); g.add(hd);
  const ab = new THREE.Mesh(new THREE.SphereGeometry(AR * .74, 24, 18), dark); ab.position.set(...AC); g.add(ab);
  const nH = 3200, nA = 1500, sp = pointsObj(nH + nA); let i = 0;
  for (let n = 0; n < nH; n++, i++) {
    const v = new THREE.Vector3(gauss(), gauss(), gauss()).normalize().multiplyScalar(HR * (n < nH * .85 ? .9 + rng() * .16 : rng() * .9));
    const cc = (rng() < .1 ? PEACH : rng() < .45 ? ICE : WHITE).map(q => q * (.6 + rng() * .4));
    setPt(sp, i, HEAD.x + v.x, HEAD.y + v.y, HEAD.z + v.z, cc, (.045 + Math.pow(rng(), 6) * .12) * S, 14);
  }
  for (let n = 0; n < nA; n++, i++) {
    const v = new THREE.Vector3(gauss(), gauss() * .9, gauss() * 1.08).normalize().multiplyScalar(AR * (n < nA * .7 ? .97 + rng() * .08 : rng() * .95));
    const cc = (rng() < .2 ? PEACH : rng() < .55 ? ICE : WHITE).map(q => q * (.4 + rng() * .5));
    setPt(sp, i, AC[0] + v.x, AC[1] + v.y, AC[2] + v.z, cc, (.03 + Math.pow(rng(), 7) * .1) * S, 14);
  }
  sp.renderOrder = 4; g.add(sp);
  abdBall = makeRibbonBall(AR * .98, 10, .45, 90, .05, 1.05); abdBall.children.forEach(m => m.renderOrder = 4); abdBall.position.set(...AC); abdBall.scale.set(1, .92, 1.08); g.add(abdBall);
  // 两只大圆眼：白色亮环 + 深色眼底 + 亮瞳
  const eyeT = canvasTex(128, 128, (x, w) => { const c = w / 2; const gl = x.createRadialGradient(c, c, 34, c, c, 62); gl.addColorStop(0, 'rgba(190,225,255,.55)'); gl.addColorStop(1, 'rgba(190,225,255,0)'); x.fillStyle = gl; x.fillRect(0, 0, w, w); x.beginPath(); x.arc(c, c, 40, 0, TAU); x.fillStyle = '#071024'; x.fill(); x.lineWidth = 7; x.strokeStyle = '#f2f8ff'; x.stroke(); const p = x.createRadialGradient(c, c, 0, c, c, 18); p.addColorStop(0, '#ffffff'); p.addColorStop(.6, '#dff0ff'); p.addColorStop(1, 'rgba(160,210,255,0)'); x.fillStyle = p; x.beginPath(); x.arc(c, c, 18, 0, TAU); x.fill(); });
  spider.eyes = [-1, 1].map(s => { const e = new THREE.Sprite(new THREE.SpriteMaterial({map: eyeT, transparent: true, depthWrite: false})); e.position.set(s * .28, HEAD.y + .1, HEAD.z + HR * .96); e.scale.setScalar(.5); e.renderOrder = 5; g.add(e); return e; });
  // 脚下的暗影：星云再亮，蜘蛛也压在一块暗底上
  const shT = canvasTex(128, 128, (x, w) => { const g = x.createRadialGradient(64, 64, 0, 64, 64, 64); g.addColorStop(0, 'rgba(2,4,12,.95)'); g.addColorStop(.45, 'rgba(2,4,12,.7)'); g.addColorStop(1, 'rgba(2,4,12,0)'); x.fillStyle = g; x.fillRect(0, 0, w, w); });
  spider.shadow = new THREE.Sprite(new THREE.SpriteMaterial({map: shT, transparent: true, depthWrite: false, depthTest: false, opacity: .8})); spider.shadow.renderOrder = 3; spider.shadow.scale.setScalar(4.4 * S); world.add(spider.shadow);
  // 8 条腿：根部绕在头部两侧，前两对朝前、后两对朝后
  legG = new THREE.Group(); world.add(legG);
  const legMat = new THREE.ShaderMaterial({uniforms: {uC: {value: new THREE.Color('#b8dcff')}, uA: {value: .95}}, vertexShader: LEG_VS, fragmentShader: LEG_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending});
  const segGeo = new THREE.CylinderGeometry(.72, 1, 1, 12, 1, true);
  const ANG = [38, 72, 108, 142];
  sparkObj = pointsObj(8 * 3 * 20);
  for (let s = -1, li = 0; s <= 1; s += 2) for (let n = 0; n < 4; n++, li++) {
    const a = ANG[n] * Math.PI / 180;
    const L = {side: s, n, grp: (n + (s > 0 ? 1 : 0)) % 2,
      rootL: new THREE.Vector3(s * .5, .98, HEAD.z + .32 - n * .26),
      restL: new THREE.Vector3(s * Math.sin(a) * 3.1, 0, HEAD.z + Math.cos(a) * 3.0),
      foot: new THREE.Vector3(), step: null, segs: [], joints: [], P: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()], spk: []};
    for (let q = 0; q < 3; q++) { const m = new THREE.Mesh(segGeo, legMat); m.frustumCulled = false; m.renderOrder = 4; legG.add(m); L.segs.push(m); }
    for (let q = 0; q < 4; q++) { const j = new THREE.Sprite(new THREE.SpriteMaterial({map: GLOW, color: q === 3 ? 0xffe2cf : q === 0 ? 0x9fd4ff : 0xffc7a8, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false})); j.userData.s = q === 3 ? .5 : q === 0 ? .26 : .4; j.scale.setScalar(j.userData.s * S); j.material.opacity = q === 3 ? .9 : .75; j.renderOrder = 4; legG.add(j); L.joints.push(j); }
    for (let q = 0; q < 60; q++) L.spk.push({seg: q % 3, t: rng(), a: rng() * TAU, r: rng() * .8});
    legs.push(L);
  }
  legs.forEach((L, li) => L.spk.forEach((k, q) => { const cc = (rng() < .3 ? PEACH : rng() < .6 ? ICE : WHITE).map(v => v * (.6 + rng() * .4)); setPt(sparkObj, li * 60 + q, 0, 0, 0, cc, (.03 + Math.pow(rng(), 5) * .07) * S, 14); }));
  sparkObj.renderOrder = 4; legG.add(sparkObj);
}
const LEN = [1.5, 1.85, .78];
const tA = window.THREE ? [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] : [];
const UPV = window.THREE ? new THREE.Vector3(0, 1, 0) : null, XV = window.THREE ? new THREE.Vector3(1, 0, 0) : null;
const qN = window.THREE ? new THREE.Quaternion() : null, qY = window.THREE ? new THREE.Quaternion() : null, qP = window.THREE ? new THREE.Quaternion() : null;
function setSeg(m, a, b, r){ const d = tA[3].subVectors(b, a), len = d.length(); m.position.addVectors(a, b).multiplyScalar(.5); m.quaternion.setFromUnitVectors(UPV, d.divideScalar(len || 1)); m.scale.set(r, len, r); }
function legsStep(dt){
  const g = spider.g; g.updateMatrixWorld();
  const walking = spider.walking, l1 = LEN[0] * SS, l2 = LEN[1] * SS, l3 = LEN[2] * SS, landing = spider.land > .25;
  const stepping = [0, 0]; legs.forEach(L => { if (L.step) stepping[L.grp]++; });
  const SC = CL[spider.a], ddx = spider.dx, ddz = spider.dz;
  legs.forEach((L, li) => {
    const R = L.P[0].copy(L.rootL).applyMatrix4(g.matrixWorld);
    const T = tA[0].copy(L.restL).applyMatrix4(g.matrixWorld); if (walking) { T.x += spider.vx * .2; T.z += spider.vz * .2; } T.y = surfW(SC, T.x, T.z);
    if (!spider.air) { L.foot.x += ddx; L.foot.z += ddz; if (L.step) { L.step.from.x += ddx; L.step.from.z += ddz; L.step.to.x += ddx; L.step.to.z += ddz; } }
    if (!L.init) { L.foot.copy(T); L.init = true; }
    if (spider.air) {
      const tuck = tA[1].set(L.restL.x * .5, -.45, L.restL.z * .55).applyMatrix4(g.matrixWorld);
      L.foot.lerp(tuck, Math.min(1, dt * 22)); L.step = null;
    } else if (L.step) {
      L.step.t += dt / L.step.dur; const u = Math.min(1, L.step.t), e = ease2(u);
      L.foot.lerpVectors(L.step.from, L.step.to, e); L.foot.y += Math.sin(Math.PI * u) * .45 * SS;
      if (u >= 1) { L.foot.copy(L.step.to); L.step = null; }
    } else {
      const d = Math.hypot(L.foot.x - T.x, L.foot.z - T.z), thr = walking ? .7 * SS : .32 * SS;
      if (d > 4 * SS) L.foot.copy(T);
      else if (d > thr && (landing || (walking ? stepping[1 - L.grp] === 0 : stepping[0] + stepping[1] < 2))) {
        L.step = {from: L.foot.clone(), to: T.clone(), t: 0, dur: landing ? .09 : walking ? .13 : .2}; stepping[L.grp]++;
      }
      // 读词时前腿轻点（像在敲键）
      if (!L.step) L.foot.y = surfW(SC, L.foot.x, L.foot.z) + (!walking && crawl.phase === 'read' && L.n === 0 ? Math.max(0, Math.sin(animT * 9 + L.side) * .16 * SS) : 0);
    }
    // 腿的逆解：踝点在脚尖上方偏内，膝盖朝上
    const F = L.P[3].copy(L.foot);
    const o = tA[1].set(F.x - R.x, 0, F.z - R.z); const ol = o.length() || 1; o.divideScalar(ol);
    const A = L.P[2].set(F.x - o.x * l3 * .3, F.y + l3 * .92, F.z - o.z * l3 * .3);
    const dir = tA[2].subVectors(A, R); let d = dir.length(); dir.divideScalar(d || 1); d = clamp(d, .2, (l1 + l2) * .995);
    const ca = clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1), sa2 = Math.sqrt(1 - ca * ca);
    const perp = tA[3].copy(UPV).addScaledVector(dir, -UPV.dot(dir)).normalize();
    const K = L.P[1].copy(R).addScaledVector(dir, ca * l1).addScaledVector(perp, sa2 * l1);
    A.copy(R).addScaledVector(dir, d);   // 够不着时踝点贴着最远处
    setSeg(L.segs[0], R, K, .1 * SS); setSeg(L.segs[1], K, A, .08 * SS); setSeg(L.segs[2], A, F, .055 * SS);
    L.joints.forEach((j, q) => { j.position.copy(L.P[q]); j.scale.setScalar(j.userData.s * SS); });
    // 腿里的亮粒子
    const pa = sparkObj.geometry.attributes.position;
    L.spk.forEach((k, q) => {
      const a = L.P[k.seg], b = L.P[k.seg + 1], rr = [.09, .07, .05][k.seg] * SS * k.r;
      const x = lerp(a.x, b.x, k.t), y = lerp(a.y, b.y, k.t), z = lerp(a.z, b.z, k.t);
      pa.setXYZ(li * 60 + q, x + Math.cos(k.a + animT * .8) * rr, y + Math.sin(k.a * 1.7 + animT) * rr, z + Math.sin(k.a + animT * .8) * rr);
    });
  });
  sparkObj.geometry.attributes.position.needsUpdate = true;
}

/* ---------- 触须：从蜘蛛头部伸到词上的点线；丝线：蜘蛛走过的路 ---------- */
const TH = 16, TD = 26;
const threads = Array.from({length: TH}, () => ({on: false, w: null, g: 0, ret: false}));
function threadTo(w){ let t = threads.find(x => !x.on) || threads.reduce((a, b) => (a.g < b.g ? a : b)); Object.assign(t, {on: true, w, g: 0, ret: false}); }
function retractThreads(){ threads.forEach(t => { if (t.on) t.ret = true; }); }
function buildThreads(){
  threadObj = pointsObj(TH * TD); threadObj.renderOrder = 4;
  for (let i = 0; i < TH * TD; i++) setPt(threadObj, i, 0, -999, 0, [.85, .92, 1], .07, 15);
  world.add(threadObj);
  const cap = 3002, g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(cap * 3), 3)); g.setDrawRange(0, 0);
  trailLine = new THREE.Line(g, new THREE.LineBasicMaterial({color: 0xe6f0ff, transparent: true, opacity: .45, blending: THREE.AdditiveBlending, depthWrite: false})); trailLine.frustumCulled = false; world.add(trailLine);
  pulseSpr = new THREE.Sprite(new THREE.SpriteMaterial({map: GLOW, color: 0xfff1e6, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false})); pulseSpr.scale.setScalar(2.2); pulseSpr.visible = false; world.add(pulseSpr);
  for (let i = 0; i < 60; i++) { const s = new THREE.Sprite(new THREE.SpriteMaterial({map: GLOW, color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false})); s.visible = false; world.add(s); cometSprites.push(s); }
}
const PINK = hex3('#ff6fae'), GOLD3 = hex3('#ffd27a'), GOODC = hex3('#6ff0c0'), CYANC = hex3('#62e3ff');
function threadsStep(dt){
  const g = spider.g, H = tA[0].set(0, 1.08, HEAD.z + .55).applyMatrix4(g.matrixWorld);
  const pa = threadObj.geometry.attributes.position, ca = threadObj.geometry.attributes.aCol; let nOn = 0;
  threads.forEach((t, ti) => {
    if (t.on) { t.g = t.ret ? t.g - dt * 2.6 : Math.min(1, t.g + dt * 3.2); if (t.g <= 0) t.on = false; }
    if (t.on) nOn++;
    const w = t.w, p = w && wordPos(w), col = !w ? ICE : w.state === 'flag' || w.state === 'ask' ? PINK : w.state === 'fix' ? GOODC : w.state === 'lnk' ? CYANC : [.85, .92, 1];
    for (let j = 0; j < TD; j++) {
      const s = j / (TD - 1), o = ti * TD + j;
      if (!t.on || s > t.g) { pa.setXYZ(o, 0, -999, 0); continue; }
      const L = Math.hypot(p.x - H.x, p.z - H.z), arc = Math.sin(Math.PI * s) * Math.min(1, L * .1);
      pa.setXYZ(o, lerp(H.x, p.x, s), lerp(H.y, p.y, s) + arc, lerp(H.z, p.z, s)); ca.setXYZ(o, col[0], col[1], col[2]);
    }
  });
  pa.needsUpdate = true; ca.needsUpdate = true; tentacles = nOn;
  // 丝线
  const tp = trailLine.geometry.attributes.position, n = Math.min(trail.length, 3000), o = {};
  let L = 0, px = 0, py = 0, pz = 0, hit = null;
  for (let i = 0; i < n; i++) {
    trailAt(trail[i], o); tp.setXYZ(i, o.x, o.y + .06, o.z);
    if (i) L += Math.hypot(o.x - px, o.y - py, o.z - pz);
    px = o.x; py = o.y; pz = o.z;
  }
  if (n) { tp.setXYZ(n, spider.x, spider.y + .06, spider.z); }
  trailLenW = L;
  tp.needsUpdate = true; trailLine.geometry.setDrawRange(0, n ? n + 1 : 0); trailLine.material.opacity = .45 * trailFade;
  pulseSpr.visible = false;
}
let tentacles = 0;
function cometsDraw(){
  let si = 0; const o = {x: 0, y: 0, z: 0};
  comets.forEach(c => {
    for (let q = 0; q < 5 && si < cometSprites.length; q++, si++) {
      const u = clamp(c.t - q * .035, 0, 1), s = cometSprites[si]; cometAt(c, u, o);
      s.visible = true; s.position.set(o.x, o.y, o.z); s.material.color.set(c.col); s.material.opacity = q ? .55 - q * .1 : 1; s.scale.setScalar(c.size * (q ? 1.4 - q * .2 : 1.9));
    }
  });
  for (; si < cometSprites.length; si++) cometSprites[si].visible = false;
}

/* ---------- 镜头 ---------- */
const MODES = [{id: 'follow', zh: '跟随'}, {id: 'over', zh: '俯瞰'}, {id: 'tilt', zh: '斜看'}, {id: 'orbit', zh: '环绕'}];
const EL_OVER = 1.16;
let modeI = 0, baseAz = 0;
const cam = {pos: null, tgt: null, want: null, wantT: null, yaw: 0, pitch: 0, zoom: 1, userT: 0, focus: -1};
let PRC = [], fitD = 50, offX = 0, offY = 0, W = 1, H = 1, narrow = false, bs = .5, BW = 1920, BH = 1080;
function camWant(t){
  const m = MODES[modeI].id; let az = baseAz, el = EL_OVER, r = fitD * cam.zoom, tx = 0, ty = 0, tz = 0;
  if (cam.focus >= 0) { const c = CL[cam.focus]; tx = c.x; tz = c.z; ty = c.y0 + c.top * .5; r = Math.max(30, 10 / (.61 * (W / H) * .8)) * cam.zoom; el = .95; }
  else switch (m) {
    case 'over':   az += .04 * Math.sin(t * .05); break;
    case 'tilt':   az += .36 + .05 * Math.sin(t * .04); el = .7; r *= .86; break;
    case 'follow': {   // 读词时镜头框住整团星云（偏向蜘蛛），跳的时候紧跟蜘蛛
      const s = curSec(), c = s && crawl.phase === 'read' && !spider.air ? CL[s.ai] : null;
      tx = c ? lerp(c.x, spider.x, .4) : spider.x; tz = c ? lerp(c.z, spider.z, .4) : spider.z; ty = c ? c.y0 + c.top * .5 : spider.y * .5;
      r = Math.max(40, 14 / (.61 * (W / H) * .8)) * cam.zoom; el = 1.02; az += .14 * Math.sin(t * .05);
      // 回星核派单 / 接新单时拉回全景，看派单光沿丝线跑完整条路线
      if (crawl.phase === 'ship' || crawl.phase === 'rest' || crawl.phase === 'brief') { tx = 0; ty = 2; tz = 0; r = fitD * .6 * cam.zoom; el = 1.02; }
      break; }
    case 'orbit':  az += t * .04; el = .9; r *= .92; break;
  }
  az += cam.yaw; el = clamp(el + cam.pitch, .15, 1.45);
  cam.want.set(r * Math.sin(az) * Math.cos(el) + tx, r * Math.sin(el) + ty, r * Math.cos(az) * Math.cos(el) + tz);
  cam.wantT.set(tx, ty, tz);
}
const FIT_PTS = [];
{ const o = ORBITS[2], R = o.R; for (let i = 0; i < 36; i++) { const f = i / 36 * TAU, sn = Math.sin(f); FIT_PTS.push([Math.cos(f) * (o.ax + R * 1.05), 0, sn * (o.az + R * .55) - (sn < 0 ? R * .9 * -sn : 0)]); } }
function panelRects(){
  const hr = host.getBoundingClientRect(), out = [];
  SR.querySelectorAll('.board .dp, .board .hd .eb, .board .hd h1 > span, .board .hd .sub, .board .hd .sub2, .board .sec > *, .board .top, .board .tools, .board .sb').forEach(el => { const r = el.getBoundingClientRect(); if (r.width > 2) out.push([r.left - hr.left - 8, r.top - hr.top - 8, r.right - hr.left + 8, r.bottom - hr.top + 8]); });
  return out;
}
function fitCamera(){
  const rects = narrow ? [] : panelRects(), mg = narrow ? 6 : 8; PRC = rects;
  const v = new THREE.Vector3(), az = baseAz, el = EL_OVER;
  const oxs = narrow ? [0] : [-4, -3, -2, -1, 0, 1, 2, 3, 4].map(i => i * W * .02), oys = narrow ? [H / 2 - (64 + H - 150) / 2] : Array.from({length: 13}, (_, i) => (i - 6) * H * .022);
  let best = null;
  for (const ox of oxs) for (const oy of oys) {
    camera.setViewOffset(W, H, ox, oy, W, H); camera.updateProjectionMatrix();
    let lo = 8, hi = 400;
    for (let it = 0; it < 22; it++) {
      const D = (lo + hi) / 2;
      camera.position.set(D * Math.sin(az) * Math.cos(el), D * Math.sin(el), D * Math.cos(az) * Math.cos(el)); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
      let ok = true;
      for (const p of FIT_PTS) {
        v.set(p[0], p[1], p[2]).project(camera); const sx = (v.x + 1) / 2 * W, sy = (1 - v.y) / 2 * H;
        if (sx < mg || sx > W - mg || sy < (narrow ? 64 : mg) || sy > H - (narrow ? 150 : mg)) { ok = false; break; }
        for (const r of rects) if (sx > r[0] && sx < r[2] && sy > r[1] && sy < r[3]) { ok = false; break; }
        if (!ok) break;
      }
      if (ok) hi = D; else lo = D;
    }
    if (!best || hi < best.D - .01) best = {D: hi, ox, oy};
  }
  offX = best.ox; offY = best.oy; fitD = best.D;
  camera.setViewOffset(W, H, offX, offY, W, H); camera.updateProjectionMatrix();
}

/* ---------- 建场景（WebGL 不可用时只跑面板） ---------- */
try {
  if (!THREE) throw new Error('three.js 没加载');
  renderer = new THREE.WebGLRenderer({canvas: cv, antialias: true, powerPreference: 'high-performance'});
  renderer.setClearColor(0x03050c, 1);
  pr = Math.min(window.devicePixelRatio || 1, 1.75); renderer.setPixelRatio(pr);
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(34, 16 / 9, .5, 600); scene.add(camera);
  world = new THREE.Group(); scene.add(world);
  GLOW = canvasTex(64, 64, (x, w) => { const g = x.createRadialGradient(32, 32, 0, 32, 32, 32); g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(.25, 'rgba(255,255,255,.6)'); g.addColorStop(1, 'rgba(255,255,255,0)'); x.fillStyle = g; x.fillRect(0, 0, w, w); });
  buildNebulae(); buildCore(); buildStreaks(); buildSpider(); buildThreads();
  if (THREE.EffectComposer && THREE.UnrealBloomPass && THREE.RenderPass) {
    composer = new THREE.EffectComposer(renderer);
    composer.addPass(new THREE.RenderPass(scene, camera));
    bloom = new THREE.UnrealBloomPass(new THREE.Vector2(512, 512), .72, .5, .22); composer.addPass(bloom);
  }
  cam.pos = new THREE.Vector3(0, 60, 30); cam.tgt = new THREE.Vector3(); cam.want = new THREE.Vector3(); cam.wantT = new THREE.Vector3();
  glOK = true;
} catch (e) {
  console.error(e);
  $('#glFail').hidden = false;
}

/* ================= 5. HUD ================= */
const nr = $('#nr'), board = $('#board'), fitIn = $('#fitIn'), lblLayer = $('#lbls'), tip = $('#tip');
const clEls = AG.slice(0, 13).map((a, k) => {
  const el = document.createElement('div');
  if (k === 0) { el.className = 'core'; el.innerHTML = `<b>host</b><i>Harness</i><small>LISTENING</small>`; }
  else { el.className = 'cl idle'; el.style.setProperty('--c', a.col); el.innerHTML = `<b>—</b><i>待命</i><small>—</small>`; }
  lblLayer.appendChild(el); return el;
});
const wtPool = Array.from({length: 40}, () => { const el = document.createElement('div'); el.className = 'wt'; el.style.display = 'none'; lblLayer.appendChild(el); return {el, w: null, key: ''}; });
const logEl = $('#log'), secsEl = $('#secs'), tabsEl = $('#tabs'), codeEl = $('#code');
const VB = {crawl: 'crawl', walk: 'jump', read: 'read', link: 'link', flag: 'flag', ask: 'ask', fix: 'fix', ship: 'ship', load: 'load'};
function renderLog(){
  if (!logDirty) return; logDirty = false;
  logEl.innerHTML = logs.slice(0, 11).map(l => `<li><span class="tm">${l.tm}</span><span class="vb ${l.verb}">${VB[l.verb] || l.verb}</span><span class="tx">${l.text}</span></li>`).join('');
}
function secState(si){ if (!task) return 'w'; if (si < crawl.sec || (task.sections[si] && task.sections[si].done)) return 'd'; if (si === crawl.sec && (crawl.phase === 'read' || crawl.phase === 'walk')) return 'c'; return 'w'; }
function renderTabs(){
  if (!task) return;
  const cells = [`<i class="${crawl.phase === 'brief' ? 'c' : 'd'}" style="--c:#f4f7ff">00 brief</i>`]
    .concat(task.sections.map((s, i) => { const st = secState(i); return `<i class="${st === 'w' ? '' : st}" style="--c:${AG[s.ai].col}">${pad(i + 1)} ${AG[s.ai].k.toLowerCase()}</i>`; }))
    .concat([`<i class="${crawl.phase === 'ship' || crawl.phase === 'return' ? 'c' : crawl.phase === 'rest' ? 'd' : ''}" style="--c:#ffb48f">${pad(task.sections.length + 1)} ship</i>`]);
  const h = cells.join(''); if (tabsEl._h !== h) { tabsEl.innerHTML = h; tabsEl._h = h; }
}
function renderSec(){
  const sec = $('#sec');
  if (!task) {
    $('#secT').innerHTML = 'HOST · <b>0 AGENT</b> · 当前没有可显示的智能体';
    $('#secNo').textContent = '00'; $('#secName').textContent = 'HOST'; $('#secZh').textContent = '等待事件';
    $('#secS').innerHTML = transport === 'offline' ? '事件流断开 · 正在重连'
      : transport === 'denied' ? '鉴权失败 401 · 检查 token'
        : paused ? '已暂停刷新' : '监听 Harness 事件流 · 尚无 agent 记录';
    sec.style.setProperty('--c', '#9fd4ff');
    return;
  }
  const ph = crawl.phase, s = curSec();
  $('#secT').innerHTML = `AGENTS ${task.id} · <b>${task.name}</b> · ${task.sections.length} 个 agent · ${task.total} 次调用`;
  let no, name, zh, sub, col;
  if (ph === 'brief') { no = '00'; name = 'HOST'; zh = '监听中'; col = '#f4f7ff'; sub = `只读接收 Harness 事件 · 成功率 ${Math.round(task.shown)}% · 下一步：跳到有活动的 agent`; }
  else if (s && (ph === 'walk' || ph === 'read')) {
    const a = AG[s.ai], run = s.words.filter(w => w.status === 'running'), bad = s.words.filter(w => w.state === 'flag').length;
    no = pad(crawl.sec + 1); name = a.k; zh = `${a.zh} · ${a.role}`; col = a.col;
    sub = ph === 'walk' ? `星云蛛正在跳向 ${a.k.toLowerCase()} · ${s.words.length} 次调用待读`
      : `已读 ${s.read} / ${s.words.length}` + (run.length ? ` · 进行中 ${run.length}` : '') + (bad ? ` · <em>错误 ${bad}</em>` : '') + (s.done ? ' · 本轮结束' : ' · 观察中');
  } else { no = pad(task.sections.length + 1); name = 'HOST'; zh = '汇总'; col = '#ffb48f'; sub = ph === 'ship' || ph === 'rest' ? `全部工具结束 · 成功率 ${task.final}%` : openFlags() ? `等确认 ${openFlags()} 项 · 不猜` : `成功率 ${Math.round(task.shown)}% · 活跃 agent ${task.agentCount}`; }
  $('#secNo').textContent = no; $('#secName').textContent = name; $('#secZh').textContent = zh; $('#secS').innerHTML = sub; sec.style.setProperty('--c', col);
}
function renderStrip(){
  if (!task) return;
  $('#sTen').textContent = tentacles; $('#sRead').textContent = `${task.reads}/${task.total}`; $('#sLink').textContent = task.links; $('#sFlag').textContent = task.flags;
  $('#sT').textContent = (simT - task.t0).toFixed(2); $('#sFrame').textContent = pad(frameN % 10000, 4);
}
function renderSecs(){
  if (!task) return;
  const rows = [`<div class="${crawl.phase === 'brief' ? 'c' : ''}" style="--c:#f4f7ff"><span>brief</span><u><s style="width:${crawl.phase === 'brief' ? Math.min(100, crawl.t / 2.2 * 100) : 100}%"></s></u><em>${task.total}</em></div>`]
    .concat(task.sections.map((s, i) => { const st = secState(i); return `<div class="${st === 'c' ? 'c' : st === 'w' ? 'w' : ''}" style="--c:${AG[s.ai].col}"><span>${AG[s.ai].k.toLowerCase()}</span><u><s style="width:${s.words.length ? s.read / s.words.length * 100 : 0}%"></s></u><em>${s.read}/${s.words.length}</em></div>`; }));
  const h = rows.join(''); if (secsEl._h !== h) { secsEl.innerHTML = h; secsEl._h = h; }
  $('#secMeta').textContent = `${task.sections.filter(s => s.done).length} / ${task.sections.length} 已结束`;
}
function renderCounters(){
  if (!task) {
    $('#logMeta').textContent = '0 ev/s';
    $('#cRead').textContent = '0'; $('#cLink').textContent = '0'; $('#cFlag').textContent = '0'; $('#cFix').textContent = '0'; $('#cGuess').textContent = '0';
    $('#heatMeta').textContent = '0 / 0 次调用'; $('#codeMeta').textContent = 'no agent · ' + transport;
    $('#mTask').textContent = '—'; $('#mScore').textContent = '0'; $('#mCap').textContent = capText;
    return;
  }
  const wpm = readTimes.length / 6 * 60;
  $('#logMeta').textContent = `${(readTimes.length / 6).toFixed(1)} ev/s`;
  $('#wpm').innerHTML = `${Math.round(wpm)}<small>/m</small>`;
  $('#cRead').textContent = task.reads; $('#cLink').textContent = task.links; $('#cFlag').textContent = task.flags; $('#cFix').textContent = task.fixes; $('#cGuess').textContent = openFlags();
  $('#heatMeta').textContent = `${task.reads} / ${task.total} 次调用`;
  const claims = task.total, owners = task.agentCount, checks = task.links;
  $('#nClaim').textContent = claims; $('#nOwn').textContent = owners; $('#nChk').textContent = checks;
  $('#nClaimB').style.width = Math.min(100, claims / Math.max(1, claims) * 100) + '%'; $('#nOwnB').style.width = Math.min(100, owners / Math.max(1, task.sections.length) * 100) + '%'; $('#nChkB').style.width = Math.min(100, task.rate) + '%';
  $('#openN').textContent = openFlags();
  $('#codeMeta').textContent = `${task.id} · ${crawl.phase}`;
  $('#sbShip').textContent = fmt(shipped); $('#sbWords').textContent = fmt(wordsToday); $('#sbFix').textContent = fmt(fixesToday);
  $('#sbAvg').textContent = scoreHist.length ? (scoreHist.reduce((a, b) => a + b, 0) / scoreHist.length).toFixed(1) : Math.round(task.shown).toString();
  $('#mTask').textContent = task.name; $('#mScore').textContent = Math.round(task.shown); $('#mShip').textContent = fmt(shipped); $('#mCap').textContent = capText;
}
/* 真实事件流：每行都是 Harness 会话事件，不是模拟脚本 */
const CODE_SRC = () => {
  const d = new Date();
  const head = [['cm', `# ${transport} · ${snap ? 'snapshot ' + new Date(snap.at || Date.now()).toLocaleTimeString('zh-CN') : 'no snapshot'} · ${task ? task.agentCount + ' agent' : '0 agent'}`]];
  const body = logs.slice(0, 12).slice().reverse().map(l => [
    ['', '['], ['st', l.tm], ['', '] '], ['fn', l.verb], ['', ' · '],
    ['', String(l.text).slice(0, 52)],
  ]);
  return [head].concat(body);
};
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
function renderCode(){
  const src = CODE_SRC(); let left = codeChars, h = '';
  src.forEach((line, li) => {
    let txt = '', len = 0;
    for (const [cls, t] of line) { const take = Math.max(0, Math.min(t.length, left)); left -= take; len += take; if (take) txt += cls ? `<span class="${cls}">${esc(t.slice(0, take))}</span>` : esc(t.slice(0, take)); }
    const full = line.reduce((s, x) => s + x[1].length, 0), typing = len > 0 && len < full;
    if (len === 0 && li > 0 && left <= 0) return;
    h += `<li class="${li + 1 === codeHL && left > 0 ? 'hl' : ''}${typing ? ' cur' : ''}">${txt || ' '}</li>`;
  });
  if (codeEl._h !== h) { codeEl.innerHTML = h; codeEl._h = h; }
}
function clockTick(){ $('#clock').textContent = hms(new Date()); }

/* ---------- 底部画布：雷达 / 热力格 / 评分 ---------- */
const radX = $('#radC').getContext('2d'), heatX = $('#heatC').getContext('2d'), spX = $('#spC').getContext('2d'), gX = $('#gaugeC').getContext('2d');
let radV = AXES.map(() => .2);
function axesNow(){
  if (!task || !lastPlan) return AXES.map(() => .2);
  // 七个轴全部由真实计数推导（见 nebula-core.radarValues）
  return NC.radarValues(lastPlan).map(v => clamp(v, .08, 1));
}
function drawRadar(){
  const X = radX, Wc = X.canvas.width, Hc = X.canvas.height, cx = Wc / 2, cy = Hc / 2 + 6, R = Hc / 2 - 22, n = AXES.length;
  const want = axesNow(); radV = radV.map((v, i) => v + (want[i] - v) * .25);
  X.clearRect(0, 0, Wc, Hc); X.lineWidth = 1.5;
  for (let ring = 1; ring <= 4; ring++) { X.beginPath(); for (let i = 0; i <= n; i++) { const a = -HP + i / n * TAU, r = R * ring / 4; i ? X.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r) : X.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r); } X.strokeStyle = 'rgba(150,190,255,.12)'; X.stroke(); }
  X.font = '500 17px "Noto Sans SC", sans-serif'; X.textAlign = 'center'; X.textBaseline = 'middle';
  for (let i = 0; i < n; i++) { const a = -HP + i / n * TAU; X.beginPath(); X.moveTo(cx, cy); X.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R); X.strokeStyle = 'rgba(150,190,255,.12)'; X.stroke(); X.fillStyle = '#7f8ca8'; X.fillText(AXES[i], cx + Math.cos(a) * (R + 16) * 1.25, cy + Math.sin(a) * (R + 12)); }
  X.beginPath(); radV.forEach((v, i) => { const a = -HP + i / n * TAU; i ? X.lineTo(cx + Math.cos(a) * R * v, cy + Math.sin(a) * R * v) : X.moveTo(cx + Math.cos(a) * R * v, cy + Math.sin(a) * R * v); }); X.closePath();
  const ok = task && task.shown >= PASS; X.fillStyle = ok ? 'rgba(111,240,192,.22)' : 'rgba(98,227,255,.18)'; X.fill(); X.strokeStyle = ok ? '#6ff0c0' : '#62e3ff'; X.lineWidth = 2.5; X.shadowColor = X.strokeStyle; X.shadowBlur = 10; X.stroke(); X.shadowBlur = 0;
}
function drawHeat(){
  const X = heatX, Wc = X.canvas.width, Hc = X.canvas.height; X.clearRect(0, 0, Wc, Hc);
  if (!task) return;
  const rows = task.sections, cols = 14, lw = 64, cw = (Wc - lw) / cols, rh = Math.min(38, (Hc - 6) / Math.max(rows.length, 4));
  X.font = '500 17px "JetBrains Mono", monospace'; X.textBaseline = 'middle'; X.textAlign = 'left';
  rows.forEach((s, r) => {
    const y = r * rh + 3; X.fillStyle = AG[s.ai].col; X.globalAlpha = secState(r) === 'w' ? .45 : 1; X.fillText(AG[s.ai].k.slice(0, 3), 0, y + rh / 2); X.globalAlpha = 1;
    for (let c = 0; c < cols; c++) {
      const w = s.words[c], x = lw + c * cw;
      let col = 'rgba(150,190,255,.07)';
      if (w) col = w.state === 'idle' ? 'rgba(150,190,255,.14)' : w.state === 'flag' || w.state === 'ask' ? '#ff6fae' : w.state === 'fix' ? '#6ff0c0' : w.state === 'lnk' ? '#62e3ff' : AG[s.ai].col;
      X.fillStyle = col; X.globalAlpha = w && w.state === 'read' ? .8 : 1; X.fillRect(x + 2, y + 3, cw - 4, rh - 6); X.globalAlpha = 1;
    }
  });
}
function drawScore(){
  // 评分曲线
  let X = spX, Wc = X.canvas.width, Hc = X.canvas.height; X.clearRect(0, 0, Wc, Hc);
  if (!task) return;
  const hs = task.hist.length ? task.hist : [[simT, task.shown]], t0 = hs[0][0], t1 = Math.max(t0 + 20, hs.at(-1)[0]);
  const py = v => Hc - 4 - v / 100 * (Hc - 8);
  X.strokeStyle = 'rgba(255,210,122,.25)'; X.setLineDash([6, 6]); X.beginPath(); X.moveTo(0, py(PASS)); X.lineTo(Wc, py(PASS)); X.stroke(); X.setLineDash([]);
  X.beginPath(); hs.forEach(([t, v], i) => { const x = (t - t0) / (t1 - t0) * Wc; i ? X.lineTo(x, py(v)) : X.moveTo(x, py(v)); }); X.strokeStyle = '#ffd27a'; X.lineWidth = 3; X.shadowColor = '#ffd27a'; X.shadowBlur = 8; X.stroke(); X.shadowBlur = 0;
  // 仪表
  X = gX; Wc = X.canvas.width; Hc = X.canvas.height; X.clearRect(0, 0, Wc, Hc);
  const cx = Wc / 2, cy = Hc - 14, R = Math.min(Wc / 2, Hc) - 22, a0 = Math.PI * .85, a1 = Math.PI * 2.15, v = task.shown / 100;
  X.lineCap = 'round'; X.lineWidth = 16; X.strokeStyle = 'rgba(150,190,255,.1)'; X.beginPath(); X.arc(cx, cy, R, a0, a1); X.stroke();
  const ok = task.shown >= PASS, col = ok ? '#6ff0c0' : task.shown >= 60 ? '#ffd27a' : '#ff6fae';
  X.strokeStyle = col; X.shadowColor = col; X.shadowBlur = 14; X.beginPath(); X.arc(cx, cy, R, a0, a0 + (a1 - a0) * v); X.stroke(); X.shadowBlur = 0;
  const ap = a0 + (a1 - a0) * PASS / 100; X.lineWidth = 3; X.lineCap = 'butt'; X.strokeStyle = 'rgba(255,255,255,.6)'; X.beginPath(); X.moveTo(cx + Math.cos(ap) * (R - 14), cy + Math.sin(ap) * (R - 14)); X.lineTo(cx + Math.cos(ap) * (R + 14), cy + Math.sin(ap) * (R + 14)); X.stroke();
  X.fillStyle = '#eaf1ff'; X.font = '700 60px "JetBrains Mono", monospace'; X.textAlign = 'center'; X.textBaseline = 'alphabetic'; X.fillText(Math.round(task.shown), cx, cy - 18);
  X.fillStyle = '#7f8ca8'; X.font = '500 17px "JetBrains Mono", monospace'; X.fillText('success %', cx, cy + 6);
}
function drawPanels(){ drawRadar(); drawHeat(); drawScore(); }

/* ================= 6. 每帧画面 ================= */
function updateScene(dt){
  U.time.value = animT;
  // 星云亮度：负载 + 闪光 + 正在被审的那团更亮
  const s = curSec(), inTask = task ? new Set(task.path) : new Set();
  for (let k = 0; k <= 12; k++) {
    let b = k === 0 ? .9 + flash[0] * .4 : .55 + load[k] * .28 + flash[k] * .4 + (inTask.has(k) ? .1 : 0);
    // 星云蛛趴着的那团：轻轻闪烁，提示它在这里干活
    if (k === spider.a && !spider.air && k > 0) b *= .78 + .22 * (.5 + .5 * Math.sin(animT * 13)) * (.7 + .3 * Math.sin(animT * 3.1));
    U.b.value[k] = b; flash[k] *= Math.exp(-dt * 2.2);
  }
  for (let k = 1; k <= 12; k++) { const c = CL[k], gp = cloudG[k]; gp.position.set(c.x, 0, c.z); gp.rotation.y = c.rot; }
  U.b.value[13] = 1; U.b.value[14] = .62; U.b.value[15] = 1.3;
  hazes.forEach(h => { h.material.opacity = h.userData.o * Math.min(1.7, U.b.value[h.userData.k] / .6) * (h.userData.k === spider.a && !spider.air ? .7 : 1); });
  if (!U.sp.value) U.sp.value = new THREE.Vector4();
  U.sp.value.set(spider.x, spider.y, spider.z, spider.air ? .001 : 2.1 * SS);
  coreBall.children.forEach(m => m.rotateOnAxis(m.userData.ax, m.userData.sp * dt));
  coreBall.rotation.y += dt * .08;
  coreBall.children.forEach(m => { m.material.uniforms.uA.value = Math.min(1.4, (m.userData.a0 || (m.userData.a0 = m.material.uniforms.uA.value)) * (1 + flash[0] * .5)); });
  ringsG.children.forEach(h => { const u = h.userData; const a = animT * u.sp; u.dot.position.set(Math.cos(a) * u.r, 0, Math.sin(a) * u.r); });
  ringsG.rotation.y += dt * .03;
  abdBall.children.forEach(m => m.rotateOnAxis(m.userData.ax, m.userData.sp * 1.6 * dt)); abdBall.rotation.y += dt * .25;
  // 星云蛛本体
  const g = spider.g; g.position.set(spider.x, spider.y + Math.abs(Math.sin(spider.bob)) * (spider.walking ? .07 : .03), spider.z);
  qN.setFromUnitVectors(UPV, tA[0].set(spider.n[0], spider.n[1], spider.n[2]).normalize()); qY.setFromAxisAngle(UPV, spider.head);
  qP.setFromAxisAngle(XV, spider.air && spider.jump ? (spider.jump.t - .5) * .5 : 0); g.quaternion.copy(qN).multiply(qY).multiply(qP);
  SS += ((spider.a === 0 && !spider.air ? 1.5 : 1) * S - SS) * Math.min(1, dt * 4);
  const sq = spider.land; g.scale.set(SS * (1 + .14 * sq), SS * (1 - .24 * sq), SS * (1 + .14 * sq));
  spider.shadow.scale.setScalar(4.4 * SS); spider.shadow.position.set(spider.x, spider.y + .1, spider.z); spider.shadow.material.opacity = spider.air ? .25 : .8;
  const bl = (animT % 4.2) < .12 ? .25 : 1; spider.eyes.forEach(e => e.scale.set(.5, .5 * bl, 1));
  legsStep(dt); threadsStep(dt); cometsDraw();
}

/* ---------- 拔取的信息小框体：读到的词 → 爬取日志 / 读词热力；模糊 → 评分；补齐 → 需求雷达；连线 → 章节 ---------- */
let ffing = false, chipN = 0;
const CHIP_TO = {read: '.p-log', fix: '.p-heat', flag: '.p-score', ask: '.p-sec'};
function flyChip(w, kind){
  const col = kind === 'flag' ? '#ff6fae' : kind === 'ask' ? '#ffd27a' : kind === 'fix' ? '#6ff0c0' : AG[w.ai].col;
  const html = kind === 'flag' ? `⚑ ERROR<i>${w.w}</i>`
    : kind === 'ask' ? `? WAIT<i>${w.w}</i>`
      : kind === 'fix' ? `✓ DONE<i>${w.fix}</i>`
        : `${AG[w.ai].k.slice(0, 4)}<i>${w.w}</i>`;
  flyFrom(wordPos(w), html, col, CHIP_TO[kind]);
}
function flyFrom(p, html, col, sel, big){
  if (ffing || narrow || !glOK || host.hidden || document.hidden || chipN >= 44) return;
  v3.set(p.x, p.y, p.z).project(camera); if (v3.z > 1 || Math.abs(v3.x) > 1.05 || Math.abs(v3.y) > 1.05) return;
  const x0 = (v3.x + 1) / 2 * W, y0 = (1 - v3.y) / 2 * H;
  const pn = $(sel); if (!pn) return;
  const hr = host.getBoundingClientRect(), r = pn.getBoundingClientRect();
  const x1 = r.left - hr.left + r.width * rnd(.2, .8), y1 = r.top - hr.top + r.height * rnd(.25, .55), sc = clamp(bs * 1.05, .62, 1.2) * (big ? 1.15 : 1);
  const el = document.createElement('div'); el.className = 'chip' + (big ? ' big' : ''); el.style.setProperty('--c', col); el.innerHTML = html;
  lblLayer.appendChild(el); chipN++;
  const mx = lerp(x0, x1, .35) + rnd(-90, 90) * sc, my = Math.min(y0, y1) - rnd(20, 70) * sc;
  const T = (x, y, k, o, e, f) => ({transform: `translate(${x.toFixed(1)}px,${y.toFixed(1)}px) translate(-50%,-50%) scale(${k.toFixed(3)})`, opacity: o, easing: e, offset: f});
  const an = el.animate([T(x0, y0, .3 * sc, 0, 'ease-out', 0), T(x0, y0 - 26 * sc, sc * 1.05, 1, 'ease-in-out', .16), T(mx, my, sc, 1, 'cubic-bezier(.55,0,.9,.45)', .44), T(x1, y1, sc * .45, .1, 'linear', 1)],
    {duration: 720, fill: 'forwards'});
  an.onfinish = () => {
    el.remove(); chipN--;
    pn.animate([{borderColor: col, boxShadow: `0 0 0 1px ${col} inset, 0 0 26px -6px ${col}`}, {borderColor: 'rgba(140,185,255,.2)', boxShadow: 'inset 0 1px 0 rgba(190,215,255,.07), 0 12px 30px rgba(0,0,0,.45)'}], {duration: 520, easing: 'ease-out'});
  };
}

/* ---------- 浮层：星云标签 / 词标签 / 星核状态 ---------- */
function project(x, y, z){ v3.set(x, y, z).project(camera); return [(v3.x + 1) / 2 * W, (1 - v3.y) / 2 * H, v3.z]; }
function placeOverlays(){
  if (!glOK || narrow) return;
  const sc = clamp(bs * 1.05, .62, 1.2) * (cam.focus >= 0 ? 1.25 : MODES[modeI].id === 'follow' ? 1.12 : 1);
  const s = curSec();
  for (let k = 1; k <= 12; k++) {
    const c = CL[k], el = clEls[k], [x, y, z] = project(c.x - c.R * .5, c.y0 + c.top * .4, c.z - c.R * .86);
    if (z > 1) { el.style.display = 'none'; continue; }
    el.style.display = '';
    el.style.setProperty('--c', AG[k].col);
    const b = el.firstChild, i2 = el.firstChild.nextSibling;
    if (b && b.textContent !== AG[k].k.toLowerCase()) b.textContent = AG[k].k.toLowerCase();
    if (i2 && i2.textContent !== AG[k].zh) i2.textContent = AG[k].zh;
    const idx = task ? task.path.indexOf(k) : -1, sec = idx >= 0 ? task.sections[idx] : null;
    let cls = 'cl idle', txt = '空槽位 · 无 agent';
    if (sec) {
      if (s === sec && (crawl.phase === 'read' || crawl.phase === 'walk')) { cls = 'cl on'; txt = `${sec.read}/${sec.words.length} 调用 · 观察中`; }
      else if (sec.done) { cls = 'cl done'; txt = `${sec.words.length} 次调用 · 已结束`; }
      else { cls = 'cl queue'; txt = `${sec.words.length} 次调用 · 已记录`; }
    } else if (!AG[k].k || AG[k].k === 'IDLE') { cls = 'cl idle'; }
    if (el.className !== cls) el.className = cls;
    const sm = el.lastChild; if (sm.textContent !== txt) sm.textContent = txt;
    const lw = (el.offsetWidth || 120) * sc, lh = 34 * sc, under = PRC.some(r => x + lw > r[0] && x < r[2] && y > r[1] && y - lh < r[3]);
    el.style.setProperty('--f', under ? '.12' : '1');
    el.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px) translateY(-100%) scale(${sc.toFixed(3)})`;
  }
  // 星核
  { const el = clEls[0], [x, y] = project(0, CORE_Y, -7.4), sm = el.lastChild;
    let txt = statusLine(), cls = '';
    if (coreSay.t > 0) { txt = coreSay.txt; cls = coreSay.txt.startsWith('DONE') ? 'ship' : 'ans'; }
    if (sm.textContent !== txt) sm.textContent = txt; if (sm.className !== cls) sm.className = cls;
    el.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px) translate(-50%,-100%) scale(${sc.toFixed(3)})`; }
  // 词标签：当前章节 + 刚审完的章节（渐隐）
  const show = [];
  if (task) task.sections.forEach((sec, si) => sec.words.forEach(w => { if (w.state !== 'idle' && w.f > .02 && (si === crawl.sec || si === crawl.sec - 1 || crawl.phase === 'ship' || crawl.phase === 'rest' || crawl.phase === 'return')) show.push(w); }));
  if (crawl.phase !== 'read' && crawl.phase !== 'walk') { /* 回星核后只留模糊词的结果 */ for (let i = show.length - 1; i >= 0; i--) if (show[i].kind !== 'vague') show.splice(i, 1); }
  else { const cur = curSec(), recent = cur ? cur.words.slice(Math.max(0, crawl.wi - 6), crawl.wi) : []; for (let i = show.length - 1; i >= 0; i--) { const w = show[i]; if (w.kind !== 'vague' && w.state !== 'lnk' && !recent.includes(w)) show.splice(i, 1); } }
  const placed = [];
  show.slice(0, wtPool.length).forEach((w, i) => {
    const P = wtPool[i], p = wordPos(w), [x, y, z] = project(p.x, p.y, p.z);
    if (z > 1) return;
    const key = w.w + w.state;
    if (P.key !== key) {
      P.key = key;
      P.el.className = 'wt' + (w.state === 'flag' ? ' flag' : w.state === 'ask' ? ' ask' : w.state === 'fix' ? ' fix' : '');
      P.el.innerHTML = w.state === 'flag' ? `${w.w} ✕ 错误` : w.state === 'ask' ? `${w.w} ? 等确认` : w.state === 'fix' ? `<s>${w.w}</s>${w.fix}` : `${w.w}`;
    }
    P.el.style.display = ''; P.el.style.setProperty('--f', (w.f * (w.sec === crawl.sec || crawl.phase !== 'read' ? 1 : .55)).toFixed(2));
    placed.push({P, x, y, w: P.el.offsetWidth * sc, h: 20 * sc});
  });
  for (let i = placed.length; i < wtPool.length; i++) if (wtPool[i].el.style.display !== 'none') { wtPool[i].el.style.display = 'none'; wtPool[i].key = ''; }
  placed.sort((a, b) => a.y - b.y); const done = [];
  const hr = host.getBoundingClientRect();
  for (let k = 0; k <= 12; k++) { const el = clEls[k]; if (el.style.display === 'none') continue; const r = el.getBoundingClientRect(); if (r.width < 2) continue; done.push({l: r.left - hr.left, r: r.right - hr.left, t: r.top - hr.top, b: r.bottom - hr.top}); }
  PRC.forEach(r => done.push({l: r[0], r: r[2], t: r[1], b: r[3]}));
  // 词标签也让开星云蛛本体，别把它盖住
  { const [sx, sy] = project(spider.x, spider.y + .5 * SS / S, spider.z), [ex] = project(spider.x + 1.6 * SS, spider.y + .5 * SS / S, spider.z), rr = Math.max(24, Math.abs(ex - sx)); done.push({l: sx - rr, r: sx + rr, t: sy - rr * .85, b: sy + rr * .7}); }
  const off = 8 * sc, minY = 8;
  placed.forEach(q => {
    let ty = q.y;
    const l = q.x - q.w / 2, r = q.x + q.w / 2;
    for (let it = 0; it < 6; it++) { const t = ty - q.h - off, b = ty - off; const hit = done.find(o => l < o.r + 3 && r > o.l - 3 && t < o.b + 2 && b > o.t - 2); if (!hit) break; const up = hit.t - 3 + off; ty = up - q.h - off < minY || hit.t < H * .14 ? hit.b + 3 + q.h + off : up; }
    q.ty = ty; done.push({l, r, t: ty - q.h - off, b: ty - off});
    const P = q.P; P.dy = P.dy == null ? ty - q.y : P.dy + (ty - q.y - P.dy) * .25;
    P.el.style.transform = `translate(${(q.x - q.w / 2).toFixed(1)}px,${(q.y + P.dy - q.h - 8 * sc).toFixed(1)}px) scale(${sc.toFixed(3)})`;
    P.el.style.transformOrigin = '0 0';
  });
}

/* ================= 7. 主循环 ================= */
let uiAcc = 0, panAcc = 0, lastNow = performance.now();
let fps = 60, fpsN = 0, fpsT = 0, lowT = 0;
function frame(now){
  if (alive) requestAnimationFrame(frame);
  if (host.hidden || document.hidden) { lastNow = now; return; }
  const real = (now - lastNow) / 1000, dt = Math.min(.1, real); lastNow = now;
  dataStep(dt); animT += dt; frameN++; coreSay.t -= dt;
  if (codeChars < 2000) codeChars += dt * 90;
  uiAcc += dt;
  if (uiAcc >= .2) { uiAcc = 0; renderLog(); renderTabs(); renderSec(); renderStrip(); renderSecs(); renderCounters(); renderCode(); }
  if ((panAcc += dt) >= .12 && !narrow) { panAcc = 0; drawPanels(); }
  if (!glOK) return;
  camStep(dt);
  updateScene(dt);
  placeOverlays();
  if (composer) composer.render(); else renderer.render(scene, camera);
  fpsN++; fpsT += Math.min(real, 2);
  if (fpsT >= 1) {
    fps = Math.round(fpsN / fpsT); fpsN = 0; fpsT = 0;
    if (fps < 30) lowT++; else lowT = 0;
    if (lowT >= 3) { lowT = 0; if (pr > 1) { pr = 1; layout(); } else if (pr > .75) { pr = .75; layout(); } else if (composer) { composer = null; } }
  }
  if (hover >= 0 && !tip.hidden) showTip(hover);
}
function camStep(dt){
  if (cam.userT > 0) cam.userT -= dt; else { cam.yaw *= Math.exp(-dt * .6); cam.pitch *= Math.exp(-dt * .6); }
  camWant(animT);
  const kk = 1 - Math.exp(-dt * (MODES[modeI].id === 'follow' && cam.focus < 0 ? (spider.air ? 4.2 : 2.6) : 1.6));
  cam.pos.lerp(cam.want, kk); cam.tgt.lerp(cam.wantT, kk);
  camera.position.copy(cam.pos); camera.lookAt(cam.tgt);
}

/* ---------- 尺寸 ---------- */
function layout(){
  if (host.hidden || host.clientWidth < 2) return;
  const r = host.getBoundingClientRect();
  W = Math.max(1, r.width); H = Math.max(1, r.height);
  narrow = W < 760 || W / H < 1.05;
  nr.classList.toggle('narrow', narrow); lblLayer.style.display = narrow ? 'none' : '';
  const fr = fitIn.getBoundingClientRect();
  bs = Math.min(fr.width / 1920, fr.height / 1080) || .2;
  BW = fr.width / bs; BH = fr.height / bs;
  board.style.width = BW + 'px'; board.style.height = BH + 'px';
  board.style.setProperty('--s', bs);
  if (!glOK) return;
  baseAz = narrow && W / H < 1 ? HP : 0;
  renderer.setPixelRatio(pr); renderer.setSize(W, H, false);
  if (composer) { composer.setPixelRatio(pr); composer.setSize(W, H); }
  camera.aspect = W / H;
  fitCamera();
  const t = Math.tan(camera.fov * Math.PI / 360);
  U.px.value = H * pr / (2 * t);
  streakG.scale.set(100 * t * camera.aspect, 100 * t, 1);
}

/* ---------- 交互 ---------- */
let hover = -1, drag = null;
function screenOf(k){ const c = CL[k]; const [x, y] = project(c.x, c.cy, c.z); return [x, y]; }
function pickAt(x, y){
  if (!glOK) return -1;
  let best = -1, bd = Infinity;
  for (let k = 0; k <= 12; k++) { const [sx, sy] = screenOf(k), r = k === 0 ? 100 : 90; const d = (sx - x) ** 2 + (sy - y) ** 2; if (d < r * r && d < bd) { bd = d; best = k; } }
  const [qx, qy] = project(spider.x, spider.y + .5, spider.z); if ((qx - x) ** 2 + (qy - y) ** 2 < 40 * 40) best = CRAWLER;
  return best;
}
function showTip(k){
  const a = AG[k]; let now;
  if (k === 0) now = task ? `${task.id} ${task.name} · 评分 ${Math.round(task.shown)} · 待答 ${openFlags()}` : '—';
  else if (k === CRAWLER) { const s = curSec(); now = spider.air ? `跳向 ${s ? AG[s.ai].k : 'CHIEF'}` : crawl.phase === 'read' && s ? `在读 ${AG[s.ai].k} · ${s.read}/${s.words.length}` : '待命'; }
  else { const idx = task ? task.path.indexOf(k) : -1, sec = idx >= 0 ? task.sections[idx] : null; now = sec ? (sec.done ? '本单已审完' : curSec() === sec ? `正在被审 · ${sec.read}/${sec.words.length}` : '本单待审') : `负载 ${Math.round(load[k] * 100)}%`; }
  tip.style.setProperty('--c', a.col);
  tip.innerHTML = `<span><b>${a.k}</b><strong>${a.zh}</strong></span><span>${a.role}</span><span>当前：${now}</span>` + (k > 0 && k < 13 ? `<span class="h">${cam.focus === k ? '再点一次返回全景' : '点击拉近看这团星云'}</span>` : '');
  tip.hidden = false;
  const [sx, sy] = k === CRAWLER ? project(spider.x, spider.y + .5, spider.z) : screenOf(k), tw = tip.offsetWidth, th = tip.offsetHeight;
  let x = sx + 24, y = sy - th / 2; if (x + tw > W - 12) x = sx - tw - 24;
  tip.style.left = clamp(x, 8, W - tw - 8) + 'px'; tip.style.top = clamp(y, 8, H - th - 8) + 'px';
}
function setFocus(k){ cam.focus = (k <= 0 || k === CRAWLER || cam.focus === k) ? -1 : k; cam.zoom = 1; cam.yaw = cam.pitch = 0; syncButtons(); }
cv.addEventListener('pointerdown', e => { drag = {x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: false}; try { cv.setPointerCapture(e.pointerId); } catch (_) {} });
cv.addEventListener('pointermove', e => {
  const r = host.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  if (drag) {
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY;
    if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 5) { drag.moved = true; cv.classList.add('drag'); }
    if (drag.moved && glOK) { cam.yaw -= dx * .005; cam.pitch += dy * .004; cam.userT = 6; tip.hidden = true; hover = -1; }
    return;
  }
  const k = pickAt(x, y); hover = k; cv.classList.toggle('hov', k >= 0);
  if (k >= 0) showTip(k); else tip.hidden = true;
});
cv.addEventListener('pointerup', e => {
  const wasDrag = drag && drag.moved; drag = null; cv.classList.remove('drag');
  if (wasDrag || !glOK) return;
  const r = host.getBoundingClientRect(), k = pickAt(e.clientX - r.left, e.clientY - r.top);
  if (k > 0 && k < 13) setFocus(k); else if (cam.focus >= 0) setFocus(cam.focus);
});
cv.addEventListener('pointerleave', () => { if (!drag) { tip.hidden = true; hover = -1; } });
cv.addEventListener('wheel', e => { if (!glOK) return; e.preventDefault(); cam.zoom = clamp(cam.zoom * Math.exp(e.deltaY * .0012), .3, 1.6); }, {passive: false});
function syncButtons(){ $$('[data-f="mode"]').forEach(b => b.textContent = cam.focus >= 0 ? '返回' : MODES[modeI].zh); }
function act(name){
  if (name === 'mode') { if (cam.focus >= 0) cam.focus = -1; else modeI = (modeI + 1) % MODES.length; cam.yaw = cam.pitch = 0; cam.zoom = 1; }
  else if (name === 'full') {
    try {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => { const b = $('[data-f="full"]'); b.textContent = '不支持'; setTimeout(() => b.textContent = '全屏', 1500); });
    } catch (e) { /* 部分窗口不允许全屏 */ }
  }
  syncButtons();
}
$$('[data-act]').forEach(b => b.addEventListener('click', () => act(b.dataset.act)));
// 原页面的「主题」按钮用于切换演示系列；大屏只有 galaxy / neon 两种主题，
// 这里让它直接改写 ?theme= 并重载，避免留下一个点不动的死按钮。
$$('[data-series-pick]').forEach(b => b.addEventListener('click', () => {
  const u = new URL(location.href);
  u.searchParams.set('theme', u.searchParams.get('theme') === 'galaxy' ? 'neon' : 'galaxy');
  location.assign(u.toString());
}));
document.addEventListener('fullscreenchange', () => { const b = $('[data-f="full"]'); if (b) b.textContent = document.fullscreenElement ? '退出全屏' : '全屏'; });
document.addEventListener('keydown', e => {
  if (host.hidden) return;
  const tag = (e.target && e.target.tagName) || '';
  if (/INPUT|TEXTAREA|SELECT/.test(tag) || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'v' || e.key === 'V') act('mode');
  if (e.key === 'Escape' && cam.focus >= 0) setFocus(cam.focus);
});

/* ---------- 开场：不再生成模拟任务，等大屏控制器喂真实快照 ---------- */
const ro = new ResizeObserver(() => layout()); ro.observe(host);
layout();
renderLog(); renderTabs(); renderSec(); renderStrip(); renderSecs(); renderCounters(); renderCode(); drawPanels();
clockTick(); const clockId = setInterval(clockTick, 1000);
syncButtons();
host.__st = () => ({phase: crawl.phase, sec: crawl.sec, score: task && Math.round(task.shown), reads: task && task.reads, flags: task && task.flags, fixes: task && task.fixes, open: openFlags(), agents: task ? task.agentCount : 0, total: task ? task.total : 0, comets: comets.length, x: spider.x.toFixed(1), z: spider.z.toFixed(1)});
host.__mode = i => { modeI = i; syncButtons(); };
host.__focus = k => setFocus(k);
host.__ui = () => { logDirty = true; renderLog(); renderTabs(); renderSec(); renderStrip(); renderSecs(); renderCounters(); renderCode(); drawPanels(); placeOverlays(); };
host.__info = () => glOK ? (renderer.info.autoReset = false, renderer.info.reset(), renderer.render(scene, camera), renderer.info.autoReset = true, {calls: renderer.info.render.calls, tris: renderer.info.render.triangles, pts: renderer.info.render.points}) : null;

const ctrl = {
  setSnapshot, setTransport, setPaused, setWaiting,
  resync: next => { suppressPends = true; setSnapshot(next); suppressPends = false; },
  debug: () => ({
    glOK, transport, paused, quiet, alive, fps, dpr: pr,
    phase: crawl.phase, section: crawl.sec, sections: task ? task.sections.map(s => ({slot: s.ai, calls: s.words.length, read: s.read})) : [],
    focusSlot: task ? task.focusSlot : 0, walking: !!spider.walking, briefT: +crawl.t.toFixed(2),
    agents: task ? task.agentCount : 0, calls: task ? task.total : 0,
    running: task ? task.sections.reduce((n, s) => n + s.words.filter(w => w.status === 'running').length, 0) : 0,
    ok: task ? task.links : 0, error: task ? task.flags : 0, awaiting: task ? task.awaiting : 0,
    rate: task ? task.rate : 0, threads: tentacles, comets: comets.length, pends: pends.length,
    spider: {slot: spider.a, air: !!spider.air, x: +spider.x.toFixed(1), z: +spider.z.toFixed(1)}, events: logs.length,
  }),
  destroy: () => {
    if (!alive) return;
    alive = false;
    ro.disconnect(); clearInterval(clockId);
    try { composer && composer.dispose && composer.dispose(); renderer && renderer.dispose(); } catch (_) { /* WebGL 上下文可能已丢失 */ }
  },
};
requestAnimationFrame(frame);
return ctrl;
}
