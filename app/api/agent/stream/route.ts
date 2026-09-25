import { writeFile } from "node:fs/promises";
import { checkWorkspace, ensureWorkspace, listWorkspaceFiles, pageMetrics, projectRoot, refreshSystemFiles, removeFilesNotIn, safeWorkspacePath } from "../../../../lib/project-workspace";
import { applyAutoFixes, applySiteImages, classifyIntent, executeVisualFixes, fixableVisualIssues, createPlan, executePlan, materializePlanDocs, planFromIntent, projectSnapshot, reviewSite, visualReview, type Intent, type SitePlan, type SiteReview, type VisualReview, type WorkflowEmitter } from "../../../../lib/agent-workflow";
import { inspectPreview, restoreWorkspaceFromPreview, saveRunReport, syncWorkspaceToPreview, validatePreview, type InspectResult, type ValidationResult } from "../../../../lib/preview-client";
import { enterStage, formatSummaryTable, RunTelemetry, withRun } from "../../../../lib/telemetry";

export const runtime = "nodejs";

function previewUrl(projectId: string) {
  return `/api/preview?projectId=${encodeURIComponent(projectId)}&v=${Date.now()}`;
}

const MAX_REPAIR_ROUNDS = 3;

type HistoryItem = { role?: string; text?: string };

// 最近几轮对话，只保留文字，供意图识别和修改 Agent 理解指代。
function formatHistory(history: unknown) {
  if (!Array.isArray(history)) return "";
  return (history as HistoryItem[])
    .filter((item) => (item.role === "user" || item.role === "assistant") && typeof item.text === "string" && item.text.trim())
    .slice(-8)
    .map((item) => `${item.role === "user" ? "用户" : "Copilot"}：${String(item.text).trim().slice(0, 600)}`)
    .join("\n");
}

const intentLabels: Record<Intent, string> = {
  new_site: "新建网站：完整规划 → 页面骨架 → 全站基础 → 页面并行实现",
  modify: "修改现有网站：直接修改相关文件",
  fix: "修复问题：先构建和检查，发现问题再修复",
  ask: "回答问题：只读，不修改文件",
};

// 在终端里留一份执行轨迹。浏览器断开或刷新后，仍然能查到 Agent 每一步做了什么。
function logEvent(projectId: string, event: Record<string, unknown>) {
  if (event.type === "tool_started") return;
  const label = typeof event.label === "string" ? event.label : event.type === "completed" ? "完成" : "";
  const error = typeof event.error === "string" && event.error ? ` ✗ ${event.error.slice(0, 300)}` : "";
  console.log(`[agent:${projectId}] ${new Date().toLocaleTimeString("zh-CN", { hour12: false })} ${String(event.type)} ${label}${error}`);
}

export async function POST(request: Request) {
  let body: { message?: string; projectId?: string; apiKey?: string; history?: unknown };
  try { body = await request.json() as typeof body; } catch { return Response.json({ error: "请求格式不正确" }, { status: 400 }); }
  const message = body.message?.trim();
  const projectId = body.projectId?.trim() || "coffee-studio";
  const apiKey = body.apiKey?.trim() || process.env.DEEPSEEK_API_KEY || "";
  const history = formatHistory(body.history);
  if (!message) return Response.json({ error: "请先描述你想创建或修改的网站" }, { status: 400 });
  if (!apiKey) return Response.json({ error: "请先填写 DeepSeek API Key" }, { status: 400 });

  const root = projectRoot(projectId);
  await ensureWorkspace(root);
  await restoreWorkspaceFromPreview(projectId, root).catch(() => false);
  await refreshSystemFiles(root);
  const encoder = new TextEncoder();
  // 浏览器断开（刷新、关闭标签页）时只停止推送事件，建站流程继续跑完，
  // 结果照常同步到预览快照；否则一次刷新就会让几分钟的工作半途而废。
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit: WorkflowEmitter = async (event) => {
        logEvent(projectId, event);
        if (closed) return;
        try { controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)); } catch { closed = true; }
      };
      const close = () => { if (!closed) { closed = true; try { controller.close(); } catch { /* client already gone */ } } };
      const run = new RunTelemetry(projectId, message);
      // 统一收尾：记录结果、打印汇总表、保存报告。返回一行给用户看的消耗摘要。
      let lastInspection: InspectResult | undefined;
      const finalizeRun = async (outcome: string, error?: string, review?: SiteReview, visual?: VisualReview, visualBefore?: VisualReview, visualFix?: { applied: boolean; agents: number; reverted?: string }) => {
        const files = await listWorkspaceFiles(root).catch(() => []);
        run.finalFiles = files.filter((file) => file.path.startsWith("src/")).map((file) => ({ path: file.path, bytes: file.content.length }));
        if (run.intent !== "ask") {
          const rendered = new Map((lastInspection?.routes ?? []).map((item) => [item.route, item.chars]));
          run.quality = {
            passed: outcome === "ok",
            pages: pageMetrics(files).map((page) => ({ ...page, renderedChars: rendered.get(page.route) })),
            reviewScore: review?.score,
            reviewOk: review?.ok,
            reviewIssues: review?.blockingIssues,
            visualBefore: visualBefore ? { overall: visualBefore.overall, scores: visualBefore.scores, lintMust: visualBefore.lintMust } : undefined,
            visualFix,
            visual: visual ? { overall: visual.overall, scores: visual.scores, lintMust: visual.lintMust, lintShould: visual.lintShould, skipped: visual.skipped, pages: visual.pages.map((page) => ({ route: page.route, overall: page.overall, error: page.error, issues: page.issues })) } : undefined,
          };
        }
        run.finish(outcome, error);
        const summary = run.summary();
        const table = formatSummaryTable(summary);
        console.log(`\n${table}`);
        const dir = await saveRunReport({ runId: run.runId, projectId, report: run.report(), table, transcripts: run.transcripts });
        if (dir) console.log(`[run] 完整报告：${dir}`);
        const t = summary.totals;
        return { summary, line: `本次消耗约 ¥${t.costCny} · 用时 ${Math.round(summary.wallMs / 1000)} 秒 · 模型调用 ${t.llmCalls} 次 · 输入 ${Math.round(t.promptTokens / 1000)}k（缓存命中 ${Math.round(t.cacheHitRate * 100)}%）· 输出 ${Math.round(t.completionTokens / 1000)}k（思考占 ${Math.round(t.reasoningShareOfOutput * 100)}%）· 报告 ${run.runId}` };
      };
      withRun(run, async () => {
        try {
          enterStage("intent");
          await emit({ type: "stage", stage: "intent", label: "正在理解你的需求" });
          const snapshot = await projectSnapshot(root);
          const intent = await classifyIntent(apiKey, message, history, snapshot);
          run.intent = intent.intent;
          run.intentReason = intent.reason;
          await emit({ type: "intent", intent: intent.intent, label: `${intentLabels[intent.intent]}${intent.reason ? `（${intent.reason}）` : ""}` });

          // ---- 提问：只读回答，不构建、不校验 ----
          if (intent.intent === "ask") {
            const plan = planFromIntent(intent, snapshot);
            enterStage("answer");
            const execution = await executePlan({ apiKey, projectId, message, plan, root, emit, readOnly: true, history });
            const usage = await finalizeRun("answered");
            await emit({ type: "completed", result: { reply: `${execution.reply}\n\n${usage.line}`, files: await listWorkspaceFiles(root), events: execution.events, readOnly: true, validation: { ok: true, skipped: true }, usage: usage.summary.totals } });
            return;
          }

          // ---- 新建：完整规划；修改：用意图识别结果直接开工；修复：跳过执行，直接校验 ----
          let plan: SitePlan;
          let execution: Awaited<ReturnType<typeof executePlan>> | null = null;
          if (intent.intent === "new_site") {
            plan = await createPlan(apiKey, projectId, message, root, async (label) => emit({ type: "stage", stage: "planning", label }), { forceNewSite: true, history });
            await materializePlanDocs(root, message, plan);
            await emit({ type: "plan_ready", plan });
            enterStage("execution");
            await emit({ type: "stage", stage: "execution", label: "PRD 和设计规范已生成，开始按文档建站" });
            execution = await executePlan({ apiKey, projectId, message, plan, root, emit, history });
          } else {
            plan = planFromIntent(intent, snapshot);
            if (intent.intent === "modify") {
              enterStage("execution");
              await emit({ type: "stage", stage: "execution", label: `开始修改：${intent.summary}` });
              execution = await executePlan({ apiKey, projectId, message, plan, root, emit, history });
            }
          }

          let validation: ValidationResult = { ok: false, skipped: true };
          let structuralCheck: { ok: boolean; errors?: string[]; warnings?: string[] } = { ok: true };
          let qualityReview: SiteReview | undefined;
          // 校验与修复循环：自动修复 → 配图 → 构建 → 完整性检查 → 浏览器检查 →（首轮新建时）内容审查，
          // 有问题就交给修复阶段。视觉修复之后会用更少的轮数再跑一次。
          const runChecks = async (maxRounds: number, phase: string) => {
          for (let repairRound = 0; repairRound <= maxRounds; repairRound += 1) {
            // 每一层检查的问题都收集起来一起交给修复 Agent，避免后面的检查覆盖前面的错误。
            const problems: string[] = [];
            let previewUnavailable = false;
            enterStage(`${phase}check_${repairRound}`);
            const fixes = await applyAutoFixes(root, `${phase}check_${repairRound}`);
            if (fixes.length) await emit({ type: "autofix", label: `代码自动修复了 ${fixes.length} 个问题`, error: fixes.slice(0, 3).join("；") });
            // 配图需要能构建的页面；构建失败时跳过，修复后的下一轮会再解析
            await applySiteImages(projectId, root, emit, `${phase}check_${repairRound}`).catch(() => undefined);
            let checkStarted = Date.now();
            try {
              await syncWorkspaceToPreview(projectId, root);
              await emit({ type: "validation_started", label: repairRound ? `第 ${repairRound} 次修复后重新构建预览` : "正在构建并校验预览" });
              validation = await validatePreview(projectId);
              await emit({ type: "validation_done", ...validation, label: validation.ok ? "构建通过" : "构建失败" });
              if (!validation.ok) problems.push(`构建失败：${validation.error || "未知错误"}`);
            } catch (error) {
              previewUnavailable = true;
              validation = { ok: false, skipped: true, error: error instanceof Error ? error.message : "预览服务暂不可用" };
              await emit({ type: "validation_done", ...validation, label: "预览服务不可用，跳过构建" });
            }
            run.checks.push({ round: repairRound, kind: "build", ok: validation.ok, skipped: previewUnavailable, ms: Date.now() - checkStarted, problems: validation.ok ? [] : [String(validation.error || "").slice(0, 2000)] });
            checkStarted = Date.now();
            structuralCheck = await checkWorkspace(root) as typeof structuralCheck;
            run.checks.push({ round: repairRound, kind: "structure", ok: structuralCheck.ok, ms: Date.now() - checkStarted, problems: structuralCheck.errors ?? [] });
            if (!structuralCheck.ok) {
              problems.push(...(structuralCheck.errors ?? ["项目结构检查失败"]));
              await emit({ type: "structure_check_failed", label: `完整性检查发现 ${structuralCheck.errors?.length ?? 1} 个问题`, error: structuralCheck.errors?.slice(0, 3).join("；") });
            }
            if (validation.ok) {
              await emit({ type: "inspect_started", label: "正在用浏览器逐页打开网站，检查白屏、报错和死链" });
              checkStarted = Date.now();
              const inspection = await inspectPreview(projectId);
              lastInspection = inspection;
              run.checks.push({ round: repairRound, kind: "inspect", ok: inspection.ok, skipped: inspection.skipped, ms: Date.now() - checkStarted, problems: inspection.issues });
              await emit({ type: "inspect_done", ok: inspection.ok, label: inspection.skipped ? `浏览器检查已跳过：${inspection.reason || "不可用"}` : inspection.ok ? `浏览器检查通过（${inspection.routes?.length ?? 0} 个页面）` : `浏览器检查发现 ${inspection.issues.length} 个问题`, error: inspection.issues.slice(0, 3).join("；") });
              problems.push(...inspection.issues);
            }
            // 内容审查是主观判断，只在新建网站时做一次，避免小改动被反复“再优化”。
            if (intent.intent === "new_site" && !phase && !qualityReview && !problems.length && (validation.ok || previewUnavailable)) {
              await emit({ type: "quality_review_started", label: "正在按设计 Skill 审查内容完整度和页面差异" });
              enterStage("review");
              checkStarted = Date.now();
              qualityReview = await reviewSite(apiKey, projectId, message, root);
              run.checks.push({ round: repairRound, kind: "review", ok: qualityReview.ok, ms: Date.now() - checkStarted, problems: qualityReview.blockingIssues });
              await emit({ type: "quality_review_done", label: qualityReview.ok ? `内容审查通过（${qualityReview.score} 分）` : `内容审查发现 ${qualityReview.blockingIssues.length} 个问题`, ok: qualityReview.ok, score: qualityReview.score, error: qualityReview.blockingIssues.join("；") });
              if (!qualityReview.ok) problems.push(...qualityReview.blockingIssues.map((issue) => `内容审查：${issue}`));
            }
            if (problems.length) validation = { ...validation, ok: false, error: problems.slice(0, 6).join("；") };
            if (!problems.length || repairRound === maxRounds) break;
            const repairReason = problems.slice(0, 30).map((problem) => `- ${problem}`).join("\n");
            run.repairs.push({ round: repairRound + 1, problems });
            enterStage(`${phase}repair_${repairRound + 1}`);
            await emit({ type: "repair_started", round: repairRound + 1, label: `校验发现 ${problems.length} 个问题，正在自动修复（${repairRound + 1}/${maxRounds}）`, error: problems.slice(0, 3).join("；") });
            execution = await executePlan({ apiKey, projectId, message, plan, root, emit, repairMessage: repairReason, history });
          }
          return validation.ok;
          };
          await runChecks(MAX_REPAIR_ROUNDS, "");
          // 评估用：新建网站结束时总要有一个审查分数。校验失败时循环里不会跑审查，
          // 这里补一次，只记录分数，不再触发修复。
          if (intent.intent === "new_site" && !qualityReview) {
            enterStage("final_review");
            qualityReview = await reviewSite(apiKey, projectId, message, root);
          }
          // 视觉审查 + 一轮视觉修复。修复后必须重新通过校验，并且分数不能明显下降，
          // 否则恢复修复前的版本：视觉修复只会让网站更好，不会把能用的网站改坏。
          let visual: VisualReview | undefined;
          let visualBefore: VisualReview | undefined;
          let visualFix: { applied: boolean; agents: number; reverted?: string } | undefined;
          if (intent.intent === "new_site" && validation.ok) {
            enterStage("visual_review");
            await emit({ type: "stage", stage: "visual_review", label: "正在截图并看图审查视觉效果" });
            visual = await visualReview(apiKey, projectId);
            await emit({ type: "visual_review_done", ok: !visual.skipped, label: visual.skipped ? `视觉审查已跳过：${visual.skipped}` : `视觉审查 ${visual.overall} 分（图片 ${visual.scores.imagery}、节奏 ${visual.scores.rhythm}、手机 ${visual.scores.mobile}）` });
            const fixable = visual.skipped ? { pages: new Map(), global: [] as string[] } : fixableVisualIssues(visual);
            if (process.env.AI_VISUAL_FIX !== "off" && (fixable.pages.size || fixable.global.length)) {
              const before = visual;
              const snapshot = await listWorkspaceFiles(root);
              enterStage("visual_fix");
              const fix = await executeVisualFixes({ apiKey, projectId, message, root, emit, visual: before });
              visualFix = { applied: true, agents: fix.agents };
              const restore = async (reason: string) => {
                await removeFilesNotIn(root, new Set(snapshot.map((file) => file.path)));
                for (const file of snapshot) await writeFile(safeWorkspacePath(root, file.path), file.content, "utf8");
                visualFix = { applied: false, agents: fix.agents, reverted: reason };
                await emit({ type: "visual_fix_reverted", ok: false, label: `视觉修复没有保留（${reason}），已恢复修复前的版本` });
                await runChecks(0, "restore_");
              };
              if (!await runChecks(2, "visual_")) await restore("修复后没有通过校验");
              else {
                enterStage("visual_review_after");
                await emit({ type: "stage", stage: "visual_review", label: "视觉修复完成，重新截图审查" });
                const after = await visualReview(apiKey, projectId);
                if (!after.skipped && after.overall < before.overall - 5) await restore(`视觉分数从 ${before.overall} 降到 ${after.overall}`);
                else if (!after.skipped) {
                  visualBefore = before;
                  visual = after;
                  await emit({ type: "visual_review_done", ok: true, label: `视觉修复后 ${after.overall} 分（修复前 ${before.overall} 分）` });
                }
              }
            }
          }
          const files = await listWorkspaceFiles(root);
          const check = structuralCheck.ok ? (execution?.lastCheck || await checkWorkspace(root)) : structuralCheck;
          const usage = await finalizeRun(validation.ok ? "ok" : "validation_failed", validation.ok ? undefined : validation.error, qualityReview, visual, visualBefore, visualFix);
          const baseReply = execution?.reply || (validation.ok
            ? "构建、完整性检查和浏览器检查都通过了，没有发现需要修复的问题。如果你在页面上看到了具体问题，直接描述它（例如“手机上导航错位”），我会按修改来处理。"
            : "自动修复没有完全解决问题，剩余问题见下方。");
          const visualLine = visual && !visual.skipped ? `\n视觉审查 ${visual.overall} 分${visualBefore ? `（视觉修复前 ${visualBefore.overall} 分）` : ""}${visualFix?.reverted ? `；视觉修复没有保留：${visualFix.reverted}` : ""}` : "";
          const reply = `${baseReply}${visualLine}\n\n${usage.line}`;
          await emit({
            type: "completed",
            result: {
              reply,
              files,
              events: execution?.events ?? [],
              previewUrl: validation.ok ? previewUrl(projectId) : undefined,
              plan: intent.intent === "new_site" ? plan : undefined,
              check,
              validation,
              qualityReview,
              readOnly: false,
              usage: usage.summary.totals,
            },
          });
        } catch (error) {
          const detail = error instanceof Error ? error.message : "这次建站没有完成";
          await finalizeRun("error", detail).catch(() => undefined);
          await emit({ type: "error", label: detail, message: detail });
        } finally {
          close();
        }
      });
    },
    cancel() { closed = true; },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" } });
}
