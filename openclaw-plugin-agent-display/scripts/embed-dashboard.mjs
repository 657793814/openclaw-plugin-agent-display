import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(scriptDir, "..");
const sourcePath = path.resolve(pluginRoot, "..", "index.html");
const outputDir = path.join(pluginRoot, "src", "generated");
const outputPath = path.join(outputDir, "dashboard-html.ts");

const [rawSource, bridgeCss, bridgeJs, themeDataJs] = await Promise.all([
  readFile(sourcePath, "utf8"),
  readFile(path.join(scriptDir, "dashboard-bridge.css"), "utf8"),
  readFile(path.join(scriptDir, "dashboard-bridge.js"), "utf8"),
  readFile(path.join(scriptDir, "theme-data.js"), "utf8"),
]);

if (!/<\/body>/iu.test(rawSource)) {
  throw new Error(`Could not find </body> in ${sourcePath}`);
}

const THEME_RANGES = [
  {
    theme: "ops",
    start: "function mountOps(host, SR){",
    end: "function mountSpider(host, SR){",
    declarations: [{ kind: "const", name: "CONFIG", wrapper: "__DQ_MERGE_OPS_CONFIG__" }],
  },
  {
    theme: "spider",
    start: "function mountSpider(host, SR){",
    end: "function mountNeural(host, SR){",
    declarations: [
      { kind: "const", name: "AG", wrapper: "__DQ_MERGE_AGENTS__" },
      { kind: "const", name: "WF", wrapper: "__DQ_MERGE_WORKFLOWS__" },
      { kind: "const", name: "CH", wrapper: "__DQ_MERGE_CHANNELS__" },
    ],
  },
  {
    theme: "neural",
    start: "function mountNeural(host, SR){",
    end: "function mountFactory(host, SR){",
    declarations: [
      { kind: "const", name: "AG", wrapper: "__DQ_MERGE_AGENTS__" },
      { kind: "const", name: "WF", wrapper: "__DQ_MERGE_WORKFLOWS__" },
      { kind: "const", name: "CH", wrapper: "__DQ_MERGE_CHANNELS__" },
    ],
  },
  {
    theme: "factory",
    start: "function mountFactory(host, SR){",
    end: "function mountNebula(host, SR){",
    declarations: [
      { kind: "const", name: "AG", wrapper: "__DQ_MERGE_AGENTS__" },
      { kind: "const", name: "WF", wrapper: "__DQ_MERGE_WORKFLOWS__" },
      { kind: "const", name: "CH", wrapper: "__DQ_MERGE_CHANNELS__" },
      { kind: "const", name: "PROJECTS", wrapper: "__DQ_MERGE_PROJECTS__" },
    ],
  },
  {
    theme: "nebula",
    start: "function mountNebula(host, SR){",
    end: "function mountForge(host, SR){",
    declarations: [
      { kind: "const", name: "AG", wrapper: "__DQ_MERGE_AGENTS__" },
      { kind: "const", name: "WF", wrapper: "__DQ_MERGE_WORKFLOWS__" },
    ],
  },
  {
    theme: "forge",
    start: "function mountForge(host, SR){",
    end: "function mountLoom(host, SR){",
    declarations: [
      { kind: "var", name: "AGENTS", wrapper: "__DQ_MERGE_AGENTS__" },
      { kind: "var", name: "JOBS", wrapper: "__DQ_MERGE_JOBS__" },
    ],
  },
  {
    theme: "works",
    start: "function mountLoom(host, SR){",
    end: "function mountIon(host, SR){",
    declarations: [
      { kind: "var", name: "AGENTS", wrapper: "__DQ_MERGE_AGENTS__" },
      { kind: "var", name: "JOBS", wrapper: "__DQ_MERGE_JOBS__" },
    ],
  },
  {
    theme: "ion",
    start: "function mountIon(host, SR){",
    end: "/* ================= 系列外壳：挂载主题、切换、记住选择 ================= */",
    declarations: [
      { kind: "var", name: "CASES", wrapper: "__DQ_MERGE_CASES__" },
      { kind: "var", name: "UC_SHORT", wrapper: "__DQ_MERGE_CASE_LABELS__" },
    ],
  },
  {
    theme: "park",
    start: "function mountPark(host, SR){",
    end: "/* ================= 系列外壳：挂载主题、切换、记住选择 ================= */",
    declarations: [
      { kind: "var", name: "WS", wrapper: "__DQ_MERGE_PARK_WORKSHOPS__" },
      { kind: "var", name: "CH", wrapper: "__DQ_MERGE_PARK_CHANNELS__" },
    ],
  },
];

function skipQuoted(text, start) {
  const quote = text[start];
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === quote) return index + 1;
  }
  throw new Error(`Unterminated ${quote} literal near offset ${start}`);
}

function literalEnd(text, start) {
  const stack = [];
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === "/" && next === "/") {
      const lineEnd = text.indexOf("\n", index + 2);
      index = lineEnd < 0 ? text.length : lineEnd;
      continue;
    }
    if (char === "/" && next === "*") {
      const blockEnd = text.indexOf("*/", index + 2);
      if (blockEnd < 0) throw new Error(`Unterminated block comment near offset ${index}`);
      index = blockEnd + 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      index = skipQuoted(text, index) - 1;
      continue;
    }
    if (char === "{" || char === "[") {
      stack.push(char);
      continue;
    }
    if (char === "}" || char === "]") {
      const open = stack.pop();
      if (!open) throw new Error(`Unmatched ${char} near offset ${index}`);
      if (!stack.length) return index + 1;
    }
  }
  throw new Error(`Unterminated literal near offset ${start}`);
}

function wrapDeclaration(body, declaration, theme) {
  const marker = `${declaration.kind} ${declaration.name} = `;
  const markerIndex = body.indexOf(marker);
  if (markerIndex < 0) throw new Error(`Could not find ${marker}`);
  if (body.indexOf(marker, markerIndex + marker.length) >= 0) {
    throw new Error(`Found more than one ${marker} in theme ${theme}`);
  }
  const expressionStart = markerIndex + marker.length;
  const expressionEnd = literalEnd(body, expressionStart);
  const expression = body.slice(expressionStart, expressionEnd);
  return (
    body.slice(0, expressionStart) +
    `${declaration.wrapper}(${expression}, '${theme}')` +
    body.slice(expressionEnd)
  );
}

function transformThemes(source) {
  let result = source;
  for (const range of THEME_RANGES) {
    const start = result.indexOf(range.start);
    if (start < 0) throw new Error(`Could not find theme start: ${range.start}`);
    const end = result.indexOf(range.end, start + range.start.length);
    if (end < 0) throw new Error(`Could not find theme end: ${range.end}`);
    let body = result.slice(start, end);
    for (const declaration of range.declarations) {
      body = wrapDeclaration(body, declaration, range.theme);
    }
    result = result.slice(0, start) + body + result.slice(end);
  }
  return result;
}

function transformShell(source) {
  const marker = "  let cur = null, lastFocus = null;";
  if (!source.includes(marker)) throw new Error("Could not find theme shell state");
  let result = source.replace(marker, "  let cur = null, lastFocus = null, booted = false;");
  const bootMarker = `  let start = location.hash.slice(1);
  if (!THEMES[start]) { try { start = localStorage.getItem(KEY) || ''; } catch (e) { start = ''; } }
  show(THEMES[start] ? start : 'spider');`;
  const bootReplacement = `  function preferredStart(){
    let start = location.hash.slice(1);
    if (!THEMES[start]) { try { start = localStorage.getItem(KEY) || ''; } catch (e) { start = ''; } }
    return THEMES[start] ? start : 'spider';
  }
  function boot(id){
    if (booted) return;
    booted = true;
    show(id || preferredStart());
  }
  window.__DQ_BOOT__ = boot;
  window.__DQ_APPLY__ = function(snapshot){
    if (snapshot && typeof window.__DQ_SET_SNAPSHOT__ === 'function') window.__DQ_SET_SNAPSHOT__(snapshot);
    // 根据当前主题调用对应的 UI 更新函数
    if (typeof window.__DQ_UPDATE_UI__ === 'function') window.__DQ_UPDATE_UI__(snapshot);
    boot();
  };
  setTimeout(function(){ boot(); }, 5000);`;
  if (!result.includes(bootMarker)) throw new Error("Could not find theme shell boot code");
  return result.replace(bootMarker, bootReplacement);
}

function transformAliases(source) {
  return source.replaceAll(
    "AGENTS.forEach(function (a, i) { AGI[a.id] = i; });",
    "AGENTS.forEach(function (a, i) { AGI[a.id] = i; if (a.legacy) AGI[a.legacy] = i; if (a.sourceId) AGI[a.sourceId] = i; });",
  );
}

function transformText(source) {
  return source
    .replaceAll("示例数据 · 本地模拟 · 未接模型", "OpenClaw 实时数据 · 本地动效")
    .replaceAll("示例数据 · 模拟运行", "OpenClaw 实时数据")
    .replaceAll("· 示例数据</i>", "· 实时数据</i>")
    .replaceAll("TASKS → AGENTS → OUTPUTS · 示例数据", "TASKS → AGENTS → OUTPUTS · OpenClaw 实时数据");
}

const mainScriptMarker = "<script>\n/* ===== 主题 01 · OPS 纸面工程 ===== */";

let html = transformText(transformShell(transformAliases(transformThemes(rawSource))));
if (!html.includes(mainScriptMarker)) throw new Error("Could not find main dashboard script");
html = html.replace(
  mainScriptMarker,
  `<script id="dq-theme-data">\n${themeDataJs}\n</script>\n${mainScriptMarker}`,
);

const bridge = `
<style id="dq-live-style">${bridgeCss}</style>
<div id="dq-live" data-ok="pending" data-expanded="false">
  <section id="dq-live-panel" hidden aria-label="OpenClaw 实时数据">
    <header class="dq-head">
      <div class="dq-title"><b>OPENCLAW LIVE</b><small>agent · 实时作战数据</small></div>
      <div class="dq-status"><i class="dq-dot"></i><span id="dq-status-text">连接中</span></div>
    </header>
    <div class="dq-metrics" id="dq-metrics"></div>
    <div class="dq-section"><h4>AGENTS</h4><div class="dq-list" id="dq-agents"></div></div>
    <div class="dq-section"><h4>EVENTS</h4><div class="dq-list dq-events" id="dq-events"></div></div>
    <footer class="dq-foot"><span id="dq-updated">等待数据</span><span class="dq-foot-errors" id="dq-errors"></span></footer>
  </section>
  <button id="dq-live-pill" type="button" aria-expanded="false" aria-controls="dq-live-panel">
    <span class="dq-dot"></span>
    <span class="dq-pill-label">OPENCLAW</span>
    <span class="dq-pill-sep">·</span>
    <span id="dq-pill-summary">等待数据</span>
    <span class="dq-pill-caret">▴</span>
  </button>
</div>
<script id="dq-live-bridge">${bridgeJs}</script>
`;

html = html.replace(/<\/body>/iu, `${bridge}</body>`);
const literal = JSON.stringify(html)
  .replace(/\u2028/gu, "\\u2028")
  .replace(/\u2029/gu, "\\u2029");

await mkdir(outputDir, { recursive: true });
await writeFile(
  outputPath,
  `// Generated by scripts/embed-dashboard.mjs from ../index.html. Do not edit.\nexport const dashboardHtml = ${literal};\n`,
  "utf8",
);

console.log(
  `[agent-display] embedded ${sourcePath} -> ${outputPath} (${html.length.toLocaleString()} chars)`,
);
