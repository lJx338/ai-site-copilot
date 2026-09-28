// 只读资料、生成资料卡（不建站），用来调试资料提炼。先在平台上传资料（或 POST /api/materials），再运行：
// npm run materials:test -- <projectId> <输出目录>
import { readMaterials } from "../lib/materials";
import { RunTelemetry, withRun } from "../lib/telemetry";
const [projectId = "materials-test", root = "/tmp/materials-test"] = process.argv.slice(2);
const apiKey = process.env.DEEPSEEK_API_KEY!;
const run = new RunTelemetry(projectId, "read materials");
const started = Date.now();
const result = await withRun(run, () => readMaterials({ apiKey, projectId, root, emit: (event) => { if (event.label) console.log("·", event.label); } }));
const t = run.summary().totals;
console.log(`\n用时 ${Math.round((Date.now() - started) / 1000)}s · 模型调用 ${t.llmCalls} 次 · 费用 ¥${t.costCny} · 输入 ${Math.round(t.promptTokens / 1000)}k · 输出 ${Math.round(t.completionTokens / 1000)}k`);
const failed = run.llmCalls.filter((c) => c.error); if (failed.length) console.log("失败调用", failed.map((c) => c.purpose + ": " + c.error).join(" | "));
console.log("\n===== 给用户的卡片 =====\n" + result.reply);
