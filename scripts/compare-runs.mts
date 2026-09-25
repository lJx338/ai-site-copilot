// 对比两次建站运行：成本、用时、Agent 行为、修复过程和成品质量。
// 用法：npm run compare:runs -- <基线 runId> <新 runId>
// （省略第二个参数时使用 latest.txt 指向的最近一次运行）
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { listWorkspaceFiles, pageMetrics } from "../lib/project-workspace";
import type { RunTelemetry } from "../lib/telemetry";

const runsDir = path.join(process.cwd(), ".ai-site-copilot-workspaces/.runs");
const [baseId, nextArg] = process.argv.slice(2);
const nextId = nextArg || readFileSync(path.join(runsDir, "latest.txt"), "utf8").trim();
if (!baseId) throw new Error("用法：npm run compare:runs -- <基线 runId> [新 runId]");

// 旧报告可能缺少后来加入的字段（config、quality、costAtPeakCny），读取时都要容错。
type Summary = Partial<ReturnType<RunTelemetry["summary"]>> & Pick<ReturnType<RunTelemetry["summary"]>, "totals" | "agents" | "byStage" | "wallMs" | "message" | "outcome">;

async function load(runId: string) {
  const dir = path.join(runsDir, runId);
  const report = JSON.parse(readFileSync(path.join(dir, "report.json"), "utf8")) as { summary: Summary };
  const render = existsSync(path.join(dir, "render.json")) ? JSON.parse(readFileSync(path.join(dir, "render.json"), "utf8")) as Record<string, { chars?: number; errors?: number }> : {};
  // 从归档的成品重新计算页面指标，基线和新运行使用同一口径
  const pages = existsSync(path.join(dir, "site/src/main.tsx")) ? pageMetrics(await listWorkspaceFiles(path.join(dir, "site"))) : [];
  // 旧运行没有在流程里打分时，可以事后补一个 review.json
  const review = existsSync(path.join(dir, "review.json")) ? JSON.parse(readFileSync(path.join(dir, "review.json"), "utf8")) as { score?: number } : undefined;
  // 视觉审查：优先用运行内的结果，旧运行可以事后用 npm run visual:review -- <runId> 补一个 visual.json
  const visualFile = existsSync(path.join(dir, "visual.json")) ? JSON.parse(readFileSync(path.join(dir, "visual.json"), "utf8")) as { overall: number; scores: Record<string, number>; lintMust: number } : undefined;
  const visual = report.summary.quality?.visual ?? visualFile;
  return { runId, dir, summary: report.summary, render, pages, reviewScore: report.summary.quality?.reviewScore ?? review?.score, visual };
}

const a = await load(baseId);
const b = await load(nextId);
const k = (value: number) => value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(Math.round(value));
const pct = (value: number) => `${Math.round(value * 100)}%`;
const delta = (x: number, y: number) => x ? `${y >= x ? "+" : ""}${Math.round(((y - x) / x) * 100)}%` : "";

function agentsStat(summary: Summary) {
  const agents = summary.agents as Array<{ endedBy: string; turns: number }>;
  const exhausted = agents.filter((agent) => agent.endedBy === "turn_limit").length;
  const avgTurns = agents.length ? agents.reduce((total, agent) => total + agent.turns, 0) / agents.length : 0;
  return { count: agents.length, exhausted, avgTurns };
}

const rows: Array<[string, string, string, string]> = [];
const add = (label: string, x: number | string | undefined, y: number | string | undefined, format: (v: number) => string = String, showDelta = true) => {
  const show = (v: number | string | undefined) => typeof v === "number" ? format(v) : String(v ?? "-");
  rows.push([label, show(x), show(y), showDelta && typeof x === "number" && typeof y === "number" ? delta(x, y) : ""]);
};
const ta = a.summary.totals;
const tb = b.summary.totals;
const aa = agentsStat(a.summary);
const ab = agentsStat(b.summary);
const implemented = (pages: typeof a.pages) => `${pages.filter((page) => !page.stub).length}/${pages.length}`;
const sumCode = (pages: typeof a.pages) => pages.reduce((total, page) => total + page.codeBytes, 0);
const sumChars = (run: typeof a) => Object.values(run.render).reduce((total, item) => total + (item.chars ?? 0), 0);

add("结果", a.summary.outcome, b.summary.outcome);
add("Agent 思考强度", a.summary.config?.agentReasoningEffort ?? "high", b.summary.config?.agentReasoningEffort ?? "high");
add("费用（按高峰价换算）¥", ta.costAtPeakCny ?? ta.costCny, tb.costAtPeakCny ?? tb.costCny, (v) => v.toFixed(2));
add("费用（实际）¥", ta.costCny, tb.costCny, (v) => v.toFixed(2));
add("用时 秒", a.summary.wallMs / 1000, b.summary.wallMs / 1000, (v) => String(Math.round(v)));
add("模型调用次数", ta.llmCalls, tb.llmCalls);
add("输入 token", ta.promptTokens, tb.promptTokens, k);
add("缓存命中率", ta.cacheHitRate, tb.cacheHitRate, pct, false);
add("输出 token", ta.completionTokens, tb.completionTokens, k);
add("思考占输出", ta.reasoningShareOfOutput, tb.reasoningShareOfOutput, pct, false);
add("输出被截断次数", ta.truncatedCalls, tb.truncatedCalls);
add("工具调用（失败）", `${ta.toolCalls}（${ta.failedToolCalls}）`, `${tb.toolCalls}（${tb.failedToolCalls}）`);
add("修复轮数", ta.repairRounds, tb.repairRounds);
add("Agent 数 / 轮数用尽", `${aa.count} / ${aa.exhausted}`, `${ab.count} / ${ab.exhausted}`);
add("Agent 平均轮数", aa.avgTurns, ab.avgTurns, (v) => v.toFixed(1));
add("页面已实现", implemented(a.pages), implemented(b.pages));
add("页面代码总量 字符", sumCode(a.pages), sumCode(b.pages), k);
add("渲染正文总字数", sumChars(a), sumChars(b), k);
add("内容审查分数", a.reviewScore ?? "-", b.reviewScore ?? "-");
add("视觉总分（看图审查）", a.visual?.overall, b.visual?.overall, (v) => v.toFixed(1));
for (const dimension of ["hierarchy", "rhythm", "imagery", "typography", "consistency", "mobile"]) add(`  视觉·${dimension}`, a.visual?.scores[dimension], b.visual?.scores[dimension], (v) => v.toFixed(1));
add("浏览器检查·必须修", a.visual?.lintMust, b.visual?.lintMust);

const width = [22, 18, 18, 8];
const line = (cells: string[]) => cells.map((cell, index) => cell.padEnd(width[index])).join(" │ ");
console.log(`\n对比：A = ${a.runId}（${a.summary.message}）\n      B = ${b.runId}（${b.summary.message}）\n`);
console.log(line(["指标", "A", "B", "变化"]));
console.log("─".repeat(76));
for (const row of rows) console.log(line(row));

console.log("\n按阶段费用（¥）");
const stages = new Set([...a.summary.byStage, ...b.summary.byStage].map((item: { name: string }) => item.name));
for (const stage of stages) {
  const x = a.summary.byStage.find((item: { name: string }) => item.name === stage)?.costCny ?? 0;
  const y = b.summary.byStage.find((item: { name: string }) => item.name === stage)?.costCny ?? 0;
  console.log(line([`  ${stage}`, x.toFixed(3), y.toFixed(3), delta(x, y)]));
}

console.log("\n页面（A 与 B 各自的页面，按路由）");
for (const [label, run] of [["A", a], ["B", b]] as const) {
  for (const page of run.pages) {
    console.log(`  ${label} ${page.route.padEnd(18)} ${page.stub ? "骨架" : "完成"} · 代码 ${k(page.codeBytes)} · 样式 ${k(page.cssBytes)} · 渲染字数 ${run.render[page.route]?.chars ?? "-"}`);
  }
}
console.log(`\n截图：\n  A ${path.join(a.dir, "screens")}\n  B ${path.join(b.dir, "screens")}`);
