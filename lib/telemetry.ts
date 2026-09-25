import { AsyncLocalStorage } from "node:async_hooks";

// 一次建站请求的完整观测数据：每次模型调用、工具调用、Agent、阶段、校验和修复。
// 用 AsyncLocalStorage 传递当前的 run 和作用域（阶段 / Agent），不用把参数
// 穿过每一层函数；并行的页面 Agent 各自拥有独立的作用域。

export type LlmCall = {
  seq: number;
  provider: "deepseek" | "jev";
  stage: string;
  agent: string;
  turn?: number;
  purpose: string;
  model: string;
  thinking: boolean;
  maxTokens?: number;
  messageCount: number;
  requestChars: number;
  promptTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  finishReason: string;
  toolCalls: number;
  attempts: number;
  startedMs: number;
  ms: number;
  costCny: number;
  cost: CostBreakdown;
  peak: boolean;
  error?: string;
};

export type CostBreakdown = { cacheHit: number; cacheMiss: number; output: number; reasoning: number };

export type ToolRecord = { agent: string; stage: string; name: string; path?: string; ok: boolean; ms: number; argChars: number; resultChars: number; error?: string };
export type VerifyRecord = { agent: string; round: number; ms: number; issues: string[] };
export type AgentRecord = {
  agent: string;
  stage: string;
  startedMs: number;
  ms: number;
  turns: number;
  maxTurns: number;
  toolCalls: number;
  failedToolCalls: number;
  verifyRounds: number;
  endedBy: "reply" | "verify_limit" | "turn_limit" | "error";
  remainingIssues: string[];
  promptTokensByTurn: number[];
  writtenFiles: Record<string, number>;
  error?: string;
};
export type CheckRecord = { round: number; kind: "build" | "structure" | "inspect" | "review"; ok: boolean; ms: number; skipped?: boolean; problems: string[] };
export type StageRecord = { stage: string; startedMs: number; ms: number };

type Scope = { stage: string; agent: string; turn?: number };
type Store = { run: RunTelemetry; scope: Scope };

const storage = new AsyncLocalStorage<Store>();

const envNumber = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

// DeepSeek 官方价格（元 / 百万 token，高峰时段价格），来源：
// https://api-docs.deepseek.com/zh-cn/quick_start/pricing （2026-09-25 查询）。
// 北京时间工作日 9:00–12:00、14:00–18:00 为高峰，其余时段半价（法定节假日未计入）。
// 思考 token 按输出计费。可以用 DEEPSEEK_PRICE_* 覆盖，并和平台账单对账。
const modelPrices: Record<string, { cacheHit: number; cacheMiss: number; output: number }> = {
  "deepseek-flash": { cacheHit: 0.04, cacheMiss: 2, output: 8 },
  "deepseek-v4-pro": { cacheHit: 0.3, cacheMiss: 9, output: 27 },
};

export const pricing = {
  jevInputUsd: envNumber("TYPESAFE_PRICE_INPUT_USD", 0.042),
  usdCny: envNumber("USD_CNY", 7.2),
  offPeakDiscount: envNumber("DEEPSEEK_OFF_PEAK_FACTOR", 0.5),
};

function peakPrices(model: string) {
  const base = modelPrices[model] ?? modelPrices["deepseek-flash"];
  return {
    cacheHit: envNumber("DEEPSEEK_PRICE_CACHE_HIT", base.cacheHit),
    cacheMiss: envNumber("DEEPSEEK_PRICE_CACHE_MISS", base.cacheMiss),
    output: envNumber("DEEPSEEK_PRICE_OUTPUT", base.output),
  };
}

export function isPeak(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", weekday: "short", hour: "numeric", minute: "numeric", hour12: false }).formatToParts(date);
  const weekday = parts.find((part) => part.type === "weekday")?.value ?? "";
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0) % 24;
  if (weekday === "Sat" || weekday === "Sun") return false;
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
}

export class RunTelemetry {
  readonly runId: string;
  readonly startedAt = Date.now();
  finishedAt?: number;
  intent?: string;
  intentReason?: string;
  outcome?: string;
  error?: string;
  llmCalls: LlmCall[] = [];
  tools: ToolRecord[] = [];
  verifies: VerifyRecord[] = [];
  agents: AgentRecord[] = [];
  checks: CheckRecord[] = [];
  stages: StageRecord[] = [];
  repairs: Array<{ round: number; problems: string[] }> = [];
  transcripts: Record<string, unknown[]> = {};
  finalFiles: Array<{ path: string; bytes: number }> = [];
  // 代码层面的自动修复（不花模型费用），以及用于和其他运行对比的质量指标
  autofixes: Array<{ stage: string; fixes: string[] }> = [];
  quality?: {
    passed: boolean;
    pages: Array<{ route: string; file: string; stub: boolean; codeBytes: number; cssBytes: number; files: number; renderedChars?: number }>;
    reviewScore?: number;
    reviewOk?: boolean;
    reviewIssues?: string[];
  };
  private seq = 0;
  private currentStage?: { stage: string; startedMs: number };

  constructor(readonly projectId: string, readonly message: string) {
    const stamp = new Date(this.startedAt).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "");
    this.runId = `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
  }

  now() { return Date.now() - this.startedAt; }
  nextSeq() { return ++this.seq; }

  // 顺序阶段：开始一个新阶段时自动结束上一个。
  mark(stage: string) {
    const now = this.now();
    if (this.currentStage) this.stages.push({ stage: this.currentStage.stage, startedMs: this.currentStage.startedMs, ms: now - this.currentStage.startedMs });
    this.currentStage = { stage, startedMs: now };
  }

  finish(outcome: string, error?: string) {
    this.mark("done");
    this.currentStage = undefined;
    this.finishedAt = Date.now();
    this.outcome = outcome;
    this.error = error;
  }

  summary() {
    const sum = (items: LlmCall[], key: keyof LlmCall) => items.reduce((total, item) => total + (Number(item[key]) || 0), 0);
    const round = (value: number, digits = 3) => Number(value.toFixed(digits));
    const group = (key: (call: LlmCall) => string) => {
      const groups = new Map<string, LlmCall[]>();
      for (const call of this.llmCalls) groups.set(key(call), [...(groups.get(key(call)) ?? []), call]);
      return [...groups.entries()].map(([name, calls]) => ({
        name,
        calls: calls.length,
        costCny: round(sum(calls, "costCny")),
        promptTokens: sum(calls, "promptTokens"),
        cacheHitTokens: sum(calls, "cacheHitTokens"),
        cacheMissTokens: sum(calls, "cacheMissTokens"),
        completionTokens: sum(calls, "completionTokens"),
        reasoningTokens: sum(calls, "reasoningTokens"),
        llmMs: sum(calls, "ms"),
      })).sort((a, b) => b.costCny - a.costCny);
    };
    const deepseek = this.llmCalls.filter((call) => call.provider === "deepseek");
    const promptTokens = sum(deepseek, "promptTokens");
    const cacheHitTokens = sum(deepseek, "cacheHitTokens");
    const cacheMissTokens = sum(deepseek, "cacheMissTokens");
    const completionTokens = sum(deepseek, "completionTokens");
    const reasoningTokens = sum(deepseek, "reasoningTokens");
    const part = (key: keyof CostBreakdown) => round(deepseek.reduce((total, call) => total + call.cost[key], 0));
    const costOf = {
      cacheHit: part("cacheHit"),
      cacheMiss: part("cacheMiss"),
      output: part("output"),
      reasoning: part("reasoning"),
      jev: round(sum(this.llmCalls.filter((call) => call.provider === "jev"), "costCny"), 5),
    };
    return {
      runId: this.runId,
      projectId: this.projectId,
      message: this.message,
      intent: this.intent,
      intentReason: this.intentReason,
      outcome: this.outcome,
      error: this.error,
      wallMs: (this.finishedAt ?? Date.now()) - this.startedAt,
      pricing: { ...pricing, model: process.env.DEEPSEEK_MODEL || "deepseek-flash", peakPrices: peakPrices(process.env.DEEPSEEK_MODEL || "deepseek-flash"), peakCalls: deepseek.filter((call) => call.peak).length, offPeakCalls: deepseek.filter((call) => !call.peak).length },
      totals: {
        costCny: round(Object.values(costOf).reduce((total, value) => total + value, 0)),
        // 统一按高峰价换算，不同时段的运行才能直接比较
        costAtPeakCny: round(deepseek.reduce((total, call) => total + (call.peak ? call.costCny : call.costCny / pricing.offPeakDiscount), 0)),
        // 如果全部按空闲时段价格计算，这次会花多少
        costIfOffPeakCny: round(deepseek.reduce((total, call) => total + call.costCny * (call.peak ? pricing.offPeakDiscount : 1), 0)),
        costBreakdownCny: costOf,
        llmCalls: this.llmCalls.length,
        deepseekCalls: deepseek.length,
        promptTokens,
        cacheHitTokens,
        cacheMissTokens,
        cacheHitRate: promptTokens ? round(cacheHitTokens / promptTokens, 3) : 0,
        completionTokens,
        reasoningTokens,
        reasoningShareOfOutput: completionTokens ? round(reasoningTokens / completionTokens, 3) : 0,
        truncatedCalls: deepseek.filter((call) => call.finishReason === "length").length,
        failedCalls: this.llmCalls.filter((call) => call.error).length,
        retriedCalls: deepseek.filter((call) => call.attempts > 1).length,
        toolCalls: this.tools.length,
        failedToolCalls: this.tools.filter((tool) => !tool.ok).length,
        repairRounds: this.repairs.length,
      },
      stages: this.stages,
      byStage: group((call) => call.stage),
      byAgent: group((call) => call.agent),
      byPurpose: group((call) => call.purpose),
      agents: this.agents.map((agent) => ({ ...agent, costCny: round(sum(this.llmCalls.filter((call) => call.agent === agent.agent), "costCny")) })),
      checks: this.checks,
      repairs: this.repairs,
      verifies: this.verifies,
      failedTools: this.tools.filter((tool) => !tool.ok),
      toolsByName: Object.entries(this.tools.reduce<Record<string, { count: number; ms: number; resultChars: number; argChars: number }>>((acc, tool) => {
        const entry = acc[tool.name] ?? { count: 0, ms: 0, resultChars: 0, argChars: 0 };
        entry.count += 1; entry.ms += tool.ms; entry.resultChars += tool.resultChars; entry.argChars += tool.argChars;
        acc[tool.name] = entry;
        return acc;
      }, {})).map(([name, value]) => ({ name, ...value })),
      topCalls: [...this.llmCalls].sort((a, b) => b.costCny - a.costCny).slice(0, 12),
      finalFiles: this.finalFiles,
      autofixes: this.autofixes,
      quality: this.quality,
    };
  }

  report() {
    return { summary: this.summary(), llmCalls: this.llmCalls, tools: this.tools };
  }
}

export function withRun<T>(run: RunTelemetry, fn: () => Promise<T>) {
  return storage.run({ run, scope: { stage: "intent", agent: "orchestrator" } }, fn);
}

export function withScope<T>(scope: Partial<Scope>, fn: () => Promise<T>) {
  const store = storage.getStore();
  if (!store) return fn();
  return storage.run({ run: store.run, scope: { ...store.scope, ...scope } }, fn);
}

// 设置当前异步上下文里的阶段（顺序流程用），同时给 run 打阶段时间点。
export function enterStage(stage: string) {
  const store = storage.getStore();
  if (!store) return;
  store.scope.stage = stage;
  store.run.mark(stage);
}

export function currentRun() { return storage.getStore()?.run; }
export function currentScope(): Scope { return storage.getStore()?.scope ?? { stage: "unknown", agent: "unknown" }; }

export function deepseekCost(model: string, hit: number, miss: number, completion: number, reasoning: number, when = new Date()) {
  const peak = isPeak(when);
  const factor = peak ? 1 : pricing.offPeakDiscount;
  const price = peakPrices(model);
  const cost: CostBreakdown = {
    cacheHit: (hit / 1e6) * price.cacheHit * factor,
    cacheMiss: (miss / 1e6) * price.cacheMiss * factor,
    output: ((completion - reasoning) / 1e6) * price.output * factor,
    reasoning: (reasoning / 1e6) * price.output * factor,
  };
  return { cost, total: cost.cacheHit + cost.cacheMiss + cost.output + cost.reasoning, peak, price };
}

export function jevCost(inputTokens: number) {
  return (inputTokens / 1e6) * pricing.jevInputUsd * pricing.usdCny;
}

export function formatSummaryTable(summary: ReturnType<RunTelemetry["summary"]>) {
  const k = (value: number) => value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
  const s = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  const t = summary.totals;
  const lines = [
    `===== 运行报告 ${summary.runId} · ${summary.intent ?? "?"} · ${summary.outcome ?? "?"} =====`,
    `总费用 ≈ ¥${t.costCny}（按高峰价换算 ¥${t.costAtPeakCny}；按调用时间计 ${summary.pricing.peakCalls} 次高峰 / ${summary.pricing.offPeakCalls} 次空闲价；全部空闲时段约 ¥${t.costIfOffPeakCny}）`,
    `  构成：缓存命中输入 ¥${t.costBreakdownCny.cacheHit} / 未命中输入 ¥${t.costBreakdownCny.cacheMiss} / 正文输出 ¥${t.costBreakdownCny.output} / 思考 ¥${t.costBreakdownCny.reasoning} / Jev ¥${t.costBreakdownCny.jev}）`,
    `总用时 ${s(summary.wallMs)} · 模型调用 ${t.llmCalls} 次 · 输入 ${k(t.promptTokens)}（缓存命中率 ${Math.round(t.cacheHitRate * 100)}%）· 输出 ${k(t.completionTokens)}（其中思考 ${Math.round(t.reasoningShareOfOutput * 100)}%）· 截断 ${t.truncatedCalls} · 工具调用 ${t.toolCalls}（失败 ${t.failedToolCalls}）· 修复 ${t.repairRounds} 轮`,
    ...(summary.quality ? [
      `质量：${summary.quality.passed ? "验收通过" : "验收未通过"} · 页面 ${summary.quality.pages.filter((page) => !page.stub).length}/${summary.quality.pages.length} 已实现 · 审查 ${summary.quality.reviewScore ?? "-"} 分`,
      ...summary.quality.pages.map((page) => `  ${page.route.padEnd(18)} ${page.stub ? "骨架" : "完成"} · 代码 ${(page.codeBytes / 1000).toFixed(1)}k · 样式 ${(page.cssBytes / 1000).toFixed(1)}k · 渲染字数 ${page.renderedChars ?? "-"}`),
    ] : []),
    ...(summary.autofixes.length ? [`代码自动修复：${summary.autofixes.map((item) => `${item.stage}(${item.fixes.length})`).join("、")}`] : []),
    "-- 按阶段 --",
    ...summary.stages.map((stage) => `  ${stage.stage.padEnd(22)} ${s(stage.ms)}`),
    "-- 按 Agent（费用降序）--",
    ...summary.byAgent.map((agent) => `  ${agent.name.padEnd(16)} ¥${agent.costCny.toFixed(3).padStart(7)} · ${String(agent.calls).padStart(3)} 次 · 输入 ${k(agent.promptTokens).padStart(7)} · 输出 ${k(agent.completionTokens).padStart(6)}（思考 ${k(agent.reasoningTokens)}）· ${s(agent.llmMs)}`),
  ];
  return lines.join("\n");
}
