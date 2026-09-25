import type { Intent, IntentResult, ProjectSnapshot } from "./agent-workflow";
import { currentRun, currentScope, jevCost } from "./telemetry";

// TypeSafe Jev：只做结构化判断（Choice / Noul），返回概率和置信度，不生成文本。
// 文档：https://docs.typesafe.ai/api
const endpoint = "https://api.typesafe.ai/v1/systemone";

// 置信度低于这个值时交给 DeepSeek 再判断一次。Jev 的中文能力弱于英文，宁可多走一步。
const MIN_CONFIDENCE = Number(process.env.TYPESAFE_MIN_CONFIDENCE || 0.7);

type ChoiceAnswer = { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number };
type NoulAnswer = { type: "noul"; noul: number };
type JevResponse = { model?: string; answers?: Record<string, ChoiceAnswer | NoulAnswer>; usage?: { input_tokens?: number; output_tokens?: number } };

function recordJev(started: number, requestChars: number, questionCount: number, payload?: JevResponse, error?: string) {
  const run = currentRun();
  if (!run) return;
  const scope = currentScope();
  const input = payload?.usage?.input_tokens ?? 0;
  run.llmCalls.push({
    seq: run.nextSeq(), provider: "jev", stage: scope.stage, agent: scope.agent, purpose: "intent",
    model: payload?.model ?? (process.env.TYPESAFE_MODEL || "jev-latest"), thinking: false, messageCount: questionCount, requestChars,
    promptTokens: input, cacheHitTokens: 0, cacheMissTokens: input, completionTokens: payload?.usage?.output_tokens ?? 0, reasoningTokens: 0,
    finishReason: error ? "error" : "stop", toolCalls: 0, attempts: 1, startedMs: run.now() - (Date.now() - started), ms: Date.now() - started,
    costCny: jevCost(input), cost: { cacheHit: 0, cacheMiss: jevCost(input), output: 0, reasoning: 0 }, peak: false, ...(error ? { error } : {}),
  });
}

// 指令用英文写（Jev 的主训练语言），状态保留中文原文。每个选项都写清边界，
// 因为 Jev 会按字面理解问题。
const intentCriteria: Record<Intent, string> = {
  new_site: "Build a whole website from scratch or completely redo it: the project is still the blank template, or the user wants a site for a different business than `project.brand`, or explicitly says 重做 / 重新做 / 从零 / 换成另一个网站.",
  modify: "Change or add something on the existing website: content, pages, styles, layout, copy or features. Includes feedback that names a concrete problem, e.g. 首页太空了, 手机上导航错位, 颜色太暗, 加一个会员页, 再高级一点.",
  fix: "Only asks to repair build / preview errors, or reports that the preview is broken (blank, white screen, nothing displayed, error message), or lets the system check and fix problems by itself, without naming a design or content change, e.g. 修复构建错误, 预览打不开, 报错了, 检查并修复问题.",
  ask: "A question, an explanation request, or a read-only review that must not change any files, e.g. 现在有几个页面, 用了什么配色, 帮我看看有什么问题先别改.",
};

export function jevConfigured() {
  return Boolean(process.env.TYPESAFE_API_KEY);
}

// 返回 null 表示 Jev 不可用或不够确定，由调用方回退到 DeepSeek。
export async function classifyWithJev(message: string, history: string, snapshot: ProjectSnapshot): Promise<IntentResult | null> {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) return null;
  const pages = snapshot.routes.map((route) => `${route.label} (${route.path})`);
  const questions: Record<string, unknown> = {
    intent: {
      type: "choice",
      instructions: "What does `latest_message` ask the website builder to do? Use `recent_conversation` only to resolve references such as 刚才那个 or 再改一点.",
      criteria: intentCriteria,
    },
    no_changes: {
      type: "noul",
      instructions: "Does `latest_message` explicitly say that no files should be changed right now (for example 先别改, 不要修改, 只看看)?",
    },
  };
  // 推测式并行提问：每个已有页面一个是/否问题，用来预读相关文件。
  pages.forEach((page, index) => {
    questions[`page_${index}`] = { type: "noul", instructions: `Does \`latest_message\` (with \`recent_conversation\` for context) ask to change or ask about the page \`project.pages[${index}]\`?` };
  });
  const state = {
    project: snapshot.isTemplate ? { status: "blank template, no website built yet" } : { status: "website already built", brand: snapshot.brand, pages },
    recent_conversation: history || "(none)",
    latest_message: message,
  };
  const started = Date.now();
  const body = JSON.stringify({ model: process.env.TYPESAFE_MODEL || "jev-latest", state, questions });
  const questionCount = Object.keys(questions).length;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 200);
      recordJev(started, body.length, questionCount, undefined, `HTTP ${response.status}：${detail}`);
      console.warn(`[intent] Jev 请求失败（HTTP ${response.status}）：${detail}`);
      return null;
    }
    const payload = await response.json() as JevResponse;
    recordJev(started, body.length, questionCount, payload);
    const answer = payload.answers?.intent;
    if (!answer || answer.type !== "choice" || !(answer.choice in intentCriteria)) return null;
    const noChanges = payload.answers?.no_changes;
    const routes = snapshot.routes.filter((_, index) => {
      const noul = payload.answers?.[`page_${index}`];
      return noul?.type === "noul" && noul.noul > 0.5;
    }).map((route) => route.path);
    let intent = answer.choice as Intent;
    // 组合规则放在代码里：明确说了“先别改”就只读；还没建站时只能新建。
    if (noChanges?.type === "noul" && noChanges.noul > 0.7) intent = "ask";
    if (snapshot.isTemplate && intent !== "ask") intent = "new_site";
    const percent = (value: number) => `${Math.round(value * 100)}%`;
    const result: IntentResult = {
      intent,
      summary: message.slice(0, 200),
      routes,
      reason: `Jev 判断 ${answer.choice}（概率 ${percent(answer.probabilities[answer.choice] ?? 0)}，置信度 ${percent(answer.confidence)}）`,
      provider: "jev",
      confidence: answer.confidence,
    };
    console.log(`[intent] ${payload.model ?? "jev"} ${JSON.stringify(answer.probabilities)} confidence=${answer.confidence.toFixed(2)} → ${intent}`);
    return answer.confidence >= MIN_CONFIDENCE ? result : { ...result, lowConfidence: true };
  } catch (error) {
    recordJev(started, body.length, questionCount, undefined, error instanceof Error ? error.message : String(error));
    console.warn(`[intent] Jev 调用失败：${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
