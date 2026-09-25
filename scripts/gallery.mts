// 生成两次运行的截图对比画廊（本地 HTML），按页面并排展示桌面端和手机端。
// 用法：npm run gallery -- <runA> [runB]   （省略 runB 时用最近一次运行）
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const runsDir = path.join(process.cwd(), ".ai-site-copilot-workspaces/.runs");
const [a, bArg] = process.argv.slice(2);
const b = bArg || readFileSync(path.join(runsDir, "latest.txt"), "utf8").trim();
if (!a) throw new Error("用法：npm run gallery -- <runA> [runB]");

type Visual = { overall?: number; scores?: Record<string, number>; pages?: Array<{ route: string; overall: number }> };
function info(runId: string) {
  const dir = path.join(runsDir, runId);
  const report = JSON.parse(readFileSync(path.join(dir, "report.json"), "utf8")) as { summary: { message: string; totals: { costAtPeakCny?: number; costCny: number }; quality?: { visual?: Visual } } };
  const visual: Visual | undefined = report.summary.quality?.visual ?? (existsSync(path.join(dir, "visual.json")) ? JSON.parse(readFileSync(path.join(dir, "visual.json"), "utf8")) as Visual : undefined);
  const shots = existsSync(path.join(dir, "screens")) ? readdirSync(path.join(dir, "screens")).filter((file) => file.endsWith(".jpg")) : [];
  return { runId, message: report.summary.message, cost: report.summary.totals.costAtPeakCny ?? report.summary.totals.costCny, visual, shots };
}
const A = info(a);
const B = info(b);
const pages = [...new Set([...A.shots, ...B.shots].map((file) => file.replace(/-(desktop|mobile)\.jpg$/, "")))];
const escape = (text: string) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
const pageScore = (run: typeof A, name: string) => run.visual?.pages?.find((page) => (page.route === "/" ? "home" : page.route.replace(/^\//, "").replace(/[^a-zA-Z0-9-]+/g, "_")) === name)?.overall;
const cell = (run: typeof A, name: string, viewport: string) => run.shots.includes(`${name}-${viewport}.jpg`)
  ? `<a href="${run.runId}/screens/${name}-${viewport}.jpg" target="_blank"><img loading="lazy" src="${run.runId}/screens/${name}-${viewport}.jpg" alt="${escape(run.runId)} ${name} ${viewport}"></a>`
  : `<div class="missing">无截图</div>`;
const header = (label: string, run: typeof A) => `<div class="run"><b>${label}</b> ${escape(run.runId)}<br><span>${escape(run.message)}</span><br>视觉 ${run.visual?.overall ?? "-"} 分 · 费用 ¥${run.cost}${run.visual?.scores ? `<br><small>${Object.entries(run.visual.scores).map(([key, value]) => `${key} ${value}`).join(" · ")}</small>` : ""}</div>`;
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>截图对比 ${escape(a)} vs ${escape(b)}</title>
<style>
:root{color-scheme:light dark;--bg:#f6f7f9;--fg:#1c2530;--muted:#66717f;--card:#fff;--line:#dde2e8}
@media (prefers-color-scheme:dark){:root{--bg:#12161b;--fg:#e8edf2;--muted:#93a0ae;--card:#1b2128;--line:#2c343d}}
body{margin:0;font:14px/1.6 system-ui,-apple-system,"PingFang SC",sans-serif;background:var(--bg);color:var(--fg)}
header{position:sticky;top:0;z-index:2;display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:12px 16px;background:var(--bg);border-bottom:1px solid var(--line)}
.run span,.run small{color:var(--muted)}
section{padding:16px;border-bottom:1px solid var(--line)}
h2{margin:0 0 8px;font-size:16px}
.row{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px}
.row.mobile{grid-template-columns:repeat(2,minmax(0,390px));justify-content:space-around}
img{width:100%;height:auto;display:block;border:1px solid var(--line);border-radius:6px;background:var(--card)}
.missing{padding:40px;text-align:center;color:var(--muted);border:1px dashed var(--line);border-radius:6px}
.label{color:var(--muted);font-size:12px;margin:4px 0}
@media (max-width:700px){header,.row,.row.mobile{grid-template-columns:1fr}}
</style></head><body>
<header>${header("A", A)}${header("B", B)}</header>
${pages.map((name) => `<section><h2>${escape(name)} <small>A ${pageScore(A, name) ?? "-"} 分 / B ${pageScore(B, name) ?? "-"} 分</small></h2>
<div class="label">桌面端（点击看原图）</div><div class="row">${cell(A, name, "desktop")}${cell(B, name, "desktop")}</div>
<div class="label">手机端</div><div class="row mobile">${cell(A, name, "mobile")}${cell(B, name, "mobile")}</div></section>`).join("\n")}
</body></html>`;
const out = path.join(runsDir, `gallery-${a}-vs-${b}.html`);
writeFileSync(out, html);
console.log(out);
