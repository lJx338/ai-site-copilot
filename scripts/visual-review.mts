// 给当前预览项目做一次视觉审查（浏览器客观检查 + deepseek-flash 看图打分）。
// 用法：npm run visual:review -- [runId]   （提供 runId 时把结果写进该运行的 visual.json）
// 需要 .env.local 里的 DEEPSEEK_API_KEY，并且预览服务在运行。
import { writeFileSync } from "node:fs";
import path from "node:path";
import { visualReview } from "../lib/agent-workflow";
import { RunTelemetry, withRun } from "../lib/telemetry";

const [runId] = process.argv.slice(2);
const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) throw new Error("缺少 DEEPSEEK_API_KEY（写在 .env.local 里）");
const started = Date.now();
const run = new RunTelemetry(process.env.PROJECT_ID || "coffee-studio", "visual review");
const review = await withRun(run, () => visualReview(apiKey, process.env.PROJECT_ID || "coffee-studio"));
const usage = run.summary().totals;
if (review.skipped) throw new Error(`视觉审查跳过：${review.skipped}`);

console.log(`\n视觉总分 ${review.overall} / 100 · 浏览器检查：必须修 ${review.lintMust} 处、建议 ${review.lintShould} 处 · 用时 ${Math.round((Date.now() - started) / 1000)}s · 费用 ¥${usage.costCny}（输入 ${Math.round(usage.promptTokens / 1000)}k，输出 ${Math.round(usage.completionTokens / 1000)}k）`);
console.log(`维度（0–10）：${Object.entries(review.scores).map(([key, value]) => `${key} ${value}`).join(" · ")}`);
for (const page of review.pages) {
  console.log(`\n${page.route} · ${page.error ? `失败：${page.error}` : `${page.overall} 分`} · ${Object.entries(page.scores).map(([key, value]) => `${key} ${value}`).join(" ")}`);
  for (const strength of page.strengths.slice(0, 2)) console.log(`  + ${strength}`);
  for (const issue of page.issues.slice(0, 6)) console.log(`  ${issue.severity === "must" ? "!" : "-"} [${issue.viewport} #${issue.tile} ${issue.section}] ${issue.problem} → ${issue.fix}`);
}
if (runId) {
  const file = path.join(process.cwd(), ".ai-site-copilot-workspaces/.runs", runId, "visual.json");
  writeFileSync(file, JSON.stringify(review, null, 2));
  console.log(`\n已写入 ${file}`);
}
