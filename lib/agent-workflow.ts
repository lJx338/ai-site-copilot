import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  analyzeProject,
  applyWorkspacePatch,
  autoFixProject,
  checkWorkspace,
  inspectContentQuality,
  listWorkspaceFiles,
  listWorkspaceSummaries,
  manifestRoutes,
  normalizeRoute,
  pageIssues,
  planPages,
  safeWorkspacePath,
  scaffoldSite,
  searchWorkspace,
  STUB_MARKER,
  type PlannedPage,
} from "./project-workspace";
import { classifyWithJev } from "./intent-jev";
import { currentRun, currentScope, deepseekCost, enterStage, withScope, type AgentRecord } from "./telemetry";
import { syncWorkspaceToPreview, typecheckWorkspace, validatePreview, type ValidationResult } from "./preview-client";
import { templateFiles } from "./project-template";

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
};

export type SitePagePlan = {
  name: string;
  route: string;
  goal: string;
  sections: string[];
  contentGoals: string[];
  recommendedContent: string[];
  creativeDirections: string[];
  acceptanceCriteria: string[];
};

export type SitePlan = {
  summary: string;
  mode: "new_site" | "modify_site";
  readOnly?: boolean;
  brand?: { name: string; nameEn: string; tagline: string };
  prdMarkdown: string;
  designMarkdown: string;
  assumptions: string[];
  questions: string[];
  pages: SitePagePlan[];
  sharedComponents: string[];
  filePlan: string[];
  acceptanceCriteria: string[];
};

export type WorkflowEmitter = (event: Record<string, unknown>) => Promise<void> | void;

export type SiteReview = {
  ok: boolean;
  score: number;
  blockingIssues: string[];
  suggestions: string[];
  evidence: string[];
};

export const editTools = [
  { type: "function", function: { name: "list_files", description: "列出当前 React 项目所有可编辑文件和大小。", parameters: { type: "object", properties: {}, additionalProperties: false } } },
  { type: "function", function: { name: "read_file", description: "读取一个项目文件。消息里已经附带的文件不需要重复读取。", parameters: { type: "object", properties: { path: { type: "string", description: "项目相对路径，例如 src/pages/MenuPage.tsx" } }, required: ["path"], additionalProperties: false } } },
  { type: "function", function: { name: "search_code", description: "在项目源码中搜索组件名、路由、文案或样式变量。", parameters: { type: "object", properties: { query: { type: "string", description: "要搜索的文本" } }, required: ["query"], additionalProperties: false } } },
  { type: "function", function: { name: "apply_patch", description: "对一个文件做精确的单处文本替换，适合小改动。", parameters: { type: "object", properties: { path: { type: "string" }, find: { type: "string", description: "要替换的完整上下文，必须在文件中唯一" }, replace: { type: "string", description: "替换后的内容" } }, required: ["path", "find", "replace"], additionalProperties: false } } },
  { type: "function", function: { name: "write_file", description: "创建新文件或完整改写一个文件。大面积改写时优先使用，一次写出完整内容。", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string", description: "完整文件内容" } }, required: ["path", "content"], additionalProperties: false } } },
  { type: "function", function: { name: "check_project", description: "检查项目结构、路由注册、死链、占位文案和未使用的数据文件。", parameters: { type: "object", properties: {}, additionalProperties: false } } },
  { type: "function", function: { name: "check_content", description: "检查 PRD、design.md 和页面内容质量。", parameters: { type: "object", properties: {}, additionalProperties: false } } },
] as const;

type ToolDefinition = (typeof editTools)[number];
const pickTools = (names: string[]) => editTools.filter((tool) => names.includes(tool.function.name));
// 写代码的 Agent 不需要自己调用检查工具：它结束回复后系统会自动检查并把问题发回。
const authoringTools = pickTools(["list_files", "read_file", "search_code", "apply_patch", "write_file"]);
// 页面、全站基础和修复 Agent：需要的文件预先附上，不给搜索和列目录，避免漫游式阅读。
const focusedTools = pickTools(["read_file", "apply_patch", "write_file"]);
const readOnlyTools = pickTools(["list_files", "read_file", "search_code", "check_project", "check_content"]);

const PAGE_CONCURRENCY = 3;

export const contentPolicy = `内容规则（非常重要）：
- 网站要像一个已经可以直接上线的真实网站。用户没有提供的事实（品牌名、地址、电话、营业时间、价格、产品名称与描述、团队人物、客户评价、数据）由你补全成可信、具体、全站一致的示例内容。
- 禁止任何占位写法：{占位}、{xxx}、“待确认”“待补充”“敬请期待”、lorem ipsum、example.com、138xxxx 这类打码数字。
- 全站共用事实放在 src/content/site.ts，页面从这里导入，保证各页面一致；你补全的示例事实记录在 docs/content-todo.md，方便上线前替换。
- 每个页面至少 4 个内容充实的区块：要有具体的标题、正文、列表项、数字、价格或时间，不能只有一句话或空卡片。
- 内部链接只能指向已注册的路由。`;

export const sitemapPrompt = `你是 AI 建站产品经理。先为这次需求做结构化规划，不写代码，也不写长文档。

判断业务类型、目标用户和核心转化，然后决定：
- mode：当前项目是空模板、与需求行业无关，或用户要求新建/重做网站时为 "new_site"；用户在现有网站上提出局部修改时为 "modify_site"。
- readOnly：用户只要求检查、审计、分析、不修改文件时为 true。
- brand：品牌中文名、英文名、一句话定位。用户没给就起一个可信的名字。
- pages：new_site 时按业务需要规划 4–7 个页面，每个页面都会被完整实现，不要规划做不完的页面，不要列 404 页面。modify_site 时只列出本次需要新增或修改的页面。
- route 只能用小写英文和连字符，例如 "/menu"、"/private-events"，首页为 "/"。
- 每个字符串保持简短（不超过 40 字），每个数组不超过 8 项。

只输出一个合法 JSON object，不要 Markdown 代码块：
{"summary":"一句话概括本次任务","mode":"new_site","readOnly":false,"brand":{"name":"","nameEn":"","tagline":""},"assumptions":[],"questions":[],"pages":[{"name":"首页","route":"/","goal":"","sections":[],"contentGoals":[],"recommendedContent":[],"creativeDirections":[],"acceptanceCriteria":[]}],"sharedComponents":[],"acceptanceCriteria":[]}`;

export const prdPrompt = `你是 AI 建站产品经理。根据用户需求和已经确定的页面规划，使用 requirements Skill 写一份 PRD。

直接输出 Markdown 正文，不要输出 JSON，不要用代码块包裹，控制在 5000 字以内。必须包含：项目定位与目标用户、核心转化路径、页面清单（与规划完全一致，逐页写目的、区块、内容要求和验收标准）、功能与交互状态、示例内容清单（列出由我们补全的事实类别）。`;

export const designPrompt = `你是 AI 建站设计总监。根据 PRD，使用 design-derivation Skill 写 design.md，不写代码。

直接输出 Markdown 正文，不要输出 JSON，不要用代码块包裹，控制在 7000 字以内。必须按顺序包含这些二级标题：
## 品牌与视觉方向
情绪关键词、色彩（给出具体 HEX）、字体栈、圆角与阴影、动效原则。
## 内容事实表
把用户没有提供的事实补全成具体可信的内容：品牌名、地址、营业时间、电话、价格区间、核心产品或服务清单（名称 + 一句描述 + 价格）、团队人物、至少 3 条客户评价等。所有页面都必须使用这里的事实，保证全站一致。禁止任何占位写法。
## 全站组件
Header、Footer、主 CTA 的规则。
## 页面蓝图
每个页面一个三级标题，格式严格为「### 页面名（/route）」，写叙事顺序、每个区块的具体内容与数量、图片方向和 CTA。
## 多端适配与验收`;

export const executionPrompt = `你是一个真实的网站建站 Agent，运行在一个可持续修改的 React + TypeScript 项目工作区中。相关文档和关键文件已经附在消息里，不需要重复读取；需要其他文件时再用 read_file。

执行规则：
1. 先想清楚要改哪些文件再动手。小改动用 apply_patch；新文件或大面积改写用 write_file 一次写出完整文件。
2. 公共 Header、Footer、路由、设计令牌和基础组件必须复用。新增页面时要同时加入 src/app/site-manifest.ts 的 routes 和 src/app/App.tsx 的 routes 映射。
3. 颜色、间距、圆角和阴影使用 src/styles/tokens.css 的变量。
4. 用户提出修改时只改必要的文件，保留未涉及的页面和公共层。需求或设计判断发生变化时同步更新 docs/prd.md 和 docs/design.md。
5. 你结束回复后，系统会自动运行完整性检查和 TypeScript 检查；有问题会发回给你继续修复。
6. 最终回复用简短中文说明完成了什么、做了哪些设计判断、改了哪些文件，不要贴代码。`;

const foundationPrompt = `你是建站 Agent 的「全站基础」阶段。系统已经按计划创建了每个页面的骨架文件（带 ${STUB_MARKER} 标记）并在 App.tsx 注册了路由。页面内容会由后续的页面 Agent 分别完成，你不要修改 src/pages 下的文件。

你的任务（全部完成后再结束回复）：
1. 按 design.md 改写 src/styles/tokens.css 和 design/tokens.json：颜色、字体、间距、圆角、阴影。保留已有变量名（--color-brand、--color-accent、--layout-max、--space-section 等），可以新增变量。
2. 按设计改写 src/styles/globals.css：全站基础排版、Header/Footer 样式、按钮和通用区块样式。页面专属样式由页面 Agent 写在 src/styles/pages/ 下，这里不用写。
3. 创建 src/content/site.ts：导出全站共用事实（品牌名、英文名、一句话介绍、地址、营业时间、电话、邮箱、社交账号等），内容来自 design.md 的内容事实表。
4. 更新 src/app/site-manifest.ts 的 brand（不能删除或修改已有 routes 的 path），改写 Header 和 Footer：从 site.ts 取数据，导航和主 CTA 按钮只能指向已注册的路由。
5. 更新 index.html 的 title 和 description。
6. 写 docs/content-todo.md：列出所有由你补全的示例事实，方便上线前替换。
7. 可以在 src/components/ 下新增可复用的展示组件（例如区块标题、数据条、评价卡、图片框），供各页面使用。

写入要求：
- 第 1 轮就同时写出 tokens.css、design/tokens.json、src/content/site.ts 和 index.html；第 2 轮同时写出 globals.css、Header、Footer 和共享组件。
- globals.css 一次写完整（控制在 25KB 以内），之后最多再用 apply_patch 修补 2 次，不要反复零碎修改。
- 不要修改 src/app/router.tsx、src/app/App.tsx 和 src/pages 下的文件。
- 需要的文件都已附在消息里，不需要再读取其他文件。
结束时用两三句话说明视觉方向和提供给页面的共享组件。`;

function pagePrompt(page: PlannedPage, routeList: string) {
  const prefix = page.component.replace(/Page$/, "");
  return `你是建站 Agent 的「页面」阶段，只负责一个页面：${page.name}（${page.route}），文件 ${page.file}。全站基础（设计令牌、全局样式、Header/Footer、src/content/site.ts）已经完成，其他页面由别的 Agent 并行实现。

要求：
1. 把 ${page.file} 从骨架改写成完整页面（删除 ${STUB_MARKER} 标记），完成页面目的和 design.md 中这个页面的蓝图。页尾要有明确的行动入口。
2. 页面数据写在 src/content/${page.slug}.ts 并在页面中导入使用；全站事实（品牌名、地址、电话、营业时间）从 src/content/site.ts 导入，不要重复编写，也不要与之矛盾。
3. 页面专属样式写在 src/styles/pages/${page.slug}.css，并在页面文件里 import "../styles/pages/${page.slug}.css"。使用 tokens.css 的变量；类名统一加 "${page.slug}-" 前缀，避免与其他页面冲突。
4. 需要拆分组件时，放在 src/components/sections/ 下，文件名以 ${prefix} 开头。不要修改其他任何文件（包括全局样式、Header、Footer 和共享组件）。
5. 内部链接只能指向这些已注册路由：${routeList}。
6. 写入顺序：第 1 轮就在同一轮里同时写出三个文件——${page.file}、src/content/${page.slug}.ts、src/styles/pages/${page.slug}.css。区块直接写在页面文件里即可，拆分组件不是必须的；绝不能只写数据或组件而把页面留成骨架。写完后系统会自动检查，有问题会告诉你。
7. 结束时用两三句话说明页面结构和设计取舍。`;
}

export function parseArgs(raw: string) {
  try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function normalizePlan(value: unknown): SitePlan {
  const source = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const rawPages = Array.isArray(source.pages) ? source.pages : [];
  const pages = rawPages.map((page) => {
    const item = (page && typeof page === "object" ? page : {}) as Record<string, unknown>;
    return {
      name: String(item.name ?? "未命名页面"),
      route: normalizeRoute(String(item.route ?? "/")),
      goal: String(item.goal ?? "完成页面展示"),
      sections: stringArray(item.sections),
      contentGoals: stringArray(item.contentGoals),
      recommendedContent: stringArray(item.recommendedContent),
      creativeDirections: stringArray(item.creativeDirections),
      acceptanceCriteria: stringArray(item.acceptanceCriteria),
    };
  });
  const brandSource = (source.brand && typeof source.brand === "object" ? source.brand : {}) as Record<string, unknown>;
  return {
    summary: String(source.summary ?? "根据用户需求创建并完善网站"),
    mode: source.mode === "modify_site" ? "modify_site" : "new_site",
    readOnly: source.readOnly === true,
    brand: { name: String(brandSource.name ?? ""), nameEn: String(brandSource.nameEn ?? ""), tagline: String(brandSource.tagline ?? "") },
    prdMarkdown: typeof source.prdMarkdown === "string" ? source.prdMarkdown : "",
    designMarkdown: typeof source.designMarkdown === "string" ? source.designMarkdown : "",
    assumptions: stringArray(source.assumptions),
    questions: stringArray(source.questions),
    pages,
    sharedComponents: stringArray(source.sharedComponents),
    filePlan: stringArray(source.filePlan),
    acceptanceCriteria: stringArray(source.acceptanceCriteria),
  };
}

type DeepSeekRequestOptions = {
  tools?: readonly unknown[];
  toolChoice?: unknown;
  responseFormat?: { type: "json_object" };
  thinking?: { type: "enabled" | "disabled" };
  maxTokens?: number;
  // 观测用：这次调用做什么（plan / prd / design / agent_turn / review / intent …）
  purpose?: string;
};

type DeepSeekUsage = { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } };
type DeepSeekReply = { message: ChatMessage; finishReason: string; usage?: DeepSeekUsage };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// 每次调用都记录 token、缓存命中、思考 token、耗时和估算费用。
async function deepSeekRequest(apiKey: string, messages: ChatMessage[], options: DeepSeekRequestOptions = {}): Promise<DeepSeekReply> {
  const run = currentRun();
  const scope = currentScope();
  const startedMs = run?.now() ?? 0;
  const started = Date.now();
  const meta = { attempts: 0 };
  const record = (reply?: DeepSeekReply, error?: unknown) => {
    if (!run) return;
    const usage = reply?.usage ?? {};
    const hit = usage.prompt_cache_hit_tokens ?? 0;
    const miss = usage.prompt_cache_miss_tokens ?? Math.max(0, (usage.prompt_tokens ?? 0) - hit);
    const completion = usage.completion_tokens ?? 0;
    const reasoning = usage.completion_tokens_details?.reasoning_tokens ?? 0;
    const model = process.env.DEEPSEEK_MODEL || "deepseek-flash";
    const priced = deepseekCost(model, hit, miss, completion, reasoning, new Date(started));
    run.llmCalls.push({
      seq: run.nextSeq(),
      provider: "deepseek",
      stage: scope.stage,
      agent: scope.agent,
      turn: scope.turn,
      purpose: options.purpose ?? "other",
      model,
      thinking: (options.thinking?.type ?? "enabled") === "enabled",
      maxTokens: options.maxTokens,
      messageCount: messages.length,
      requestChars: messages.reduce((total, message) => total + (message.content?.length ?? 0) + (message.reasoning_content?.length ?? 0) + (message.tool_calls ? JSON.stringify(message.tool_calls).length : 0), 0),
      promptTokens: usage.prompt_tokens ?? hit + miss,
      cacheHitTokens: hit,
      cacheMissTokens: miss,
      completionTokens: completion,
      reasoningTokens: reasoning,
      finishReason: reply?.finishReason ?? "error",
      toolCalls: reply?.message.tool_calls?.length ?? 0,
      attempts: meta.attempts,
      startedMs,
      ms: Date.now() - started,
      costCny: priced.total,
      cost: priced.cost,
      peak: priced.peak,
      ...(error ? { error: error instanceof Error ? error.message.slice(0, 300) : String(error) } : {}),
    });
  };
  try {
    const reply = await deepSeekRequestOnce(apiKey, messages, options, meta);
    record(reply);
    return reply;
  } catch (error) {
    record(undefined, error);
    throw error;
  }
}

async function deepSeekRequestOnce(apiKey: string, messages: ChatMessage[], options: DeepSeekRequestOptions, meta: { attempts: number }): Promise<DeepSeekReply> {
  const thinking = options.thinking || { type: "enabled" as const };
  // DeepSeek 的 thinking + tools 会在每一轮继续推理，tool_choice 不是这个
  // 会话的控制点。尤其是 named/required choice 会被 API 直接拒绝；auto
  // 也是 tools 存在时的默认值，因此在 thinking 模式下不发送该字段最稳妥。
  if (thinking.type === "enabled" && options.toolChoice !== undefined && options.toolChoice !== "auto") {
    throw new Error("当前 DeepSeek thinking 工具会话不支持强制指定工具，请改用 tool_choice=auto 或让模型自行选择工具。");
  }
  // 推理内容也计入 max_tokens。上限过低时 JSON 和 write_file 参数会被截断，
  // 这正是之前 PRD/设计 JSON 解析失败、页面计划为空的原因。
  const outputCap = Number(process.env.DEEPSEEK_MAX_TOKENS || 32000);
  let maxTokens = options.maxTokens ? Math.min(options.maxTokens, outputCap) : undefined;
  for (let attempt = 0; ; attempt += 1) {
    meta.attempts = attempt + 1;
    const requestBody = {
      model: process.env.DEEPSEEK_MODEL || "deepseek-flash",
      messages,
      ...(options.tools ? { tools: options.tools } : {}),
      ...(thinking.type === "disabled" && options.toolChoice !== undefined ? { tool_choice: options.toolChoice } : {}),
      ...(options.responseFormat ? { response_format: options.responseFormat } : {}),
      thinking,
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
      ...(thinking.type === "disabled" ? { temperature: 0.15 } : { reasoning_effort: "high" }),
    };
    let response: Response;
    try {
      response = await fetch(`${process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com"}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });
    } catch (error) {
      if (attempt < 2) { await sleep(2000 * (attempt + 1)); continue; }
      throw new Error(`DeepSeek 网络请求失败：${error instanceof Error ? error.message : "未知错误"}`);
    }
    const raw = await response.text();
    if (!response.ok) {
      let detail = raw.slice(0, 320);
      try {
        const payload = JSON.parse(raw) as { error?: { message?: string } | string; message?: string };
        detail = typeof payload.error === "string" ? payload.error : payload.error?.message || payload.message || detail;
      } catch { /* keep the raw response */ }
      // 并行页面 Agent 更容易触发限流；服务端错误和限流都值得重试。
      if ((response.status === 429 || response.status >= 500) && attempt < 3) { await sleep(3000 * (attempt + 1)); continue; }
      if (response.status === 400 && maxTokens && maxTokens > 8192 && /max_tokens/i.test(detail)) { maxTokens = 8192; continue; }
      if (response.status === 401) detail = `API Key 无效或已过期：${detail}`;
      if (response.status === 402) detail = `账户余额不足或未开通 API：${detail}`;
      if (response.status === 429) detail = `请求频率受限，请稍后重试：${detail}`;
      throw new Error(`DeepSeek 请求失败（HTTP ${response.status}）：${detail}`);
    }
    if (!raw.trim()) throw new Error("DeepSeek 返回了空响应，请检查 API Key 和模型配置。");
    let payload: { choices?: Array<{ message?: ChatMessage; finish_reason?: string }>; usage?: DeepSeekUsage };
    try { payload = JSON.parse(raw) as typeof payload; } catch { throw new Error(`DeepSeek 返回的不是 JSON：${raw.slice(0, 220)}`); }
    const choice = payload.choices?.[0];
    if (!choice?.message) throw new Error("DeepSeek 没有返回有效内容");
    return { message: choice.message, finishReason: choice.finish_reason || "stop", usage: payload.usage };
  }
}

async function requestJson(apiKey: string, messages: ChatMessage[], maxTokens: number, purpose: string) {
  let current = messages;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { message, finishReason } = await deepSeekRequest(apiKey, current, { responseFormat: { type: "json_object" }, maxTokens, purpose });
    try { return JSON.parse(message.content || "") as Record<string, unknown>; } catch { /* retry below */ }
    const hint = finishReason === "length" ? "上一次输出过长被截断。请输出更精简的 JSON：每个字符串不超过 30 字，每个数组不超过 6 项。" : "上一次输出不是合法 JSON。请只输出一个合法 JSON object。";
    current = [...messages.slice(0, -1), { ...messages[messages.length - 1], content: `${messages[messages.length - 1].content}\n\n注意：${hint}` }];
  }
  throw new Error("需求规划没有返回有效的 JSON，请重试");
}

async function requestMarkdown(apiKey: string, messages: ChatMessage[], maxTokens: number, purpose: string) {
  const { message } = await deepSeekRequest(apiKey, messages, { maxTokens, purpose });
  return (message.content || "").trim().replace(/^```(?:markdown|md)?\s*\n/i, "").replace(/\n```\s*$/, "").trim();
}

async function readOptionalFile(root: string | undefined, relativePath: string) {
  if (!root) return "";
  try { return await readFile(safeWorkspacePath(root, relativePath), "utf8"); } catch { return ""; }
}

async function loadSiteSkills(root?: string, names: Array<"requirements" | "design-derivation" | "site-review"> = ["requirements", "design-derivation", "site-review"]) {
  const loaded = await Promise.all(names.map(async (name) => {
    const relativePath = `skills/${name}/SKILL.md`;
    const content = await readOptionalFile(root, relativePath);
    return content ? `\n\n--- ${name} (${relativePath}) ---\n${content}` : "";
  }));
  return loaded.join("");
}

function truncate(content: string, limit: number) {
  return content.length > limit ? `${content.slice(0, limit)}\n…（已截断，需要全文时用 read_file 读取）` : content;
}

async function fileBundle(root: string, paths: string[], perFileLimit = 12000) {
  const parts: string[] = [];
  for (const relativePath of paths) {
    const content = await readOptionalFile(root, relativePath);
    if (content) parts.push(`--- ${relativePath} ---\n${truncate(content, perFileLimit)}`);
  }
  return parts.join("\n\n");
}

function cssClassSummary(css: string) {
  return [...new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((match) => match[1]))].slice(0, 160).join(" ");
}

// 页面 Agent 只需要设计文档里的全局部分和自己那一页的蓝图。
export function designExcerpt(design: string, route: string, limit = 16000) {
  const blueprintStart = design.search(/^##\s*页面蓝图/m);
  if (blueprintStart < 0) return truncate(design, limit);
  const afterTitle = design.indexOf("\n", blueprintStart) + 1 || design.length;
  const nextChapter = design.slice(afterTitle).search(/^##\s/m);
  const blueprintEnd = nextChapter >= 0 ? afterTitle + nextChapter : design.length;
  const blueprint = design.slice(afterTitle, blueprintEnd);
  const headings = [...blueprint.matchAll(/^###\s+.*$/gm)];
  const index = headings.findIndex((heading) => heading[0].includes(`（${route}）`) || heading[0].includes(`(${route})`));
  const section = index >= 0 ? blueprint.slice(headings[index].index, headings[index + 1]?.index) : "";
  return truncate(`${design.slice(0, blueprintStart)}\n## 页面蓝图（本页）\n${section.trim() || "设计文档中没有这个页面的独立蓝图，请根据页面计划和品牌方向自行设计。"}\n\n${design.slice(blueprintEnd)}`, limit);
}

function fallbackPrd(message: string, plan: SitePlan) {
  const pages = plan.pages.map((page) => `### ${page.name}（${page.route}）\n\n- 页面目的：${page.goal}\n- 核心区块：${page.sections.join("、") || "根据用户需求规划"}\n- 内容目标：${page.contentGoals.join("；") || "补充能帮助用户完成任务的完整内容"}\n- 验收标准：${page.acceptanceCriteria.join("；") || "页面信息完整、路由可访问、移动端可用"}`).join("\n\n");
  return `# 项目需求\n\n## 用户原始需求\n\n${message}\n\n## 项目摘要\n\n${plan.summary}\n\n## 页面需求\n\n${pages}\n\n## 公共组件\n\n${plan.sharedComponents.map((item) => `- ${item}`).join("\n") || "- 统一导航、页脚、按钮和页面容器"}\n\n## 合理假设\n\n${plan.assumptions.map((item) => `- ${item}`).join("\n") || "- 未提供的事实补全为可信的示例内容，并记录在 docs/content-todo.md"}\n\n## 验收标准\n\n${plan.acceptanceCriteria.map((item) => `- ${item}`).join("\n") || "- 所有页面可访问并完成各自的核心任务"}\n`;
}

function fallbackDesign(plan: SitePlan) {
  const pages = plan.pages.map((page) => `### ${page.name}（${page.route}）\n\n- 页面目的：${page.goal}\n- 必须包含：${page.sections.join("、") || "根据页面目的规划区块"}\n- 内容目标：${page.contentGoals.join("；") || "使用足够的信息、图片和行动入口完成页面任务"}\n- 创作空间：${page.creativeDirections.join("；") || "可以自行选择区块顺序、布局和文案表达"}\n- 验收标准：${page.acceptanceCriteria.join("；") || "内容完整、视觉统一、移动端可用"}`).join("\n\n");
  return `# 设计规范\n\n## 品牌与视觉方向\n\n- 核心定位：${plan.summary}\n- 颜色、字体、间距、圆角和阴影统一由 design/tokens.json 与 src/styles/tokens.css 管理。\n\n## 内容事实表\n\n用户没有提供的事实由 Agent 补全为可信、具体、全站一致的示例内容，集中放在 src/content/site.ts，并在 docs/content-todo.md 中列出。禁止占位写法。\n\n## 全站组件\n\n公共布局保持一致；主要行动入口在首屏和页面结尾可见。\n\n## 页面蓝图\n\n${pages}\n\n## 多端适配与验收\n\n桌面端、平板和移动端需要分别检查导航、卡片、表单、图片和 CTA；每个区块都要有具体内容，不能只有一句话或空卡片。\n`;
}

export async function materializePlanDocs(root: string, message: string, plan: SitePlan) {
  if (plan.readOnly) return;
  const existingPrd = await readOptionalFile(root, "docs/prd.md");
  const existingDesign = await readOptionalFile(root, "docs/design.md");
  const existingSitePlan = await readOptionalFile(root, "docs/site-plan.json");
  const keepExisting = plan.mode === "modify_site";
  const prd = plan.prdMarkdown.trim() || (keepExisting && existingPrd.trim() ? existingPrd : fallbackPrd(message, plan));
  const design = plan.designMarkdown.trim() || (keepExisting && existingDesign.trim() ? existingDesign : fallbackDesign(plan));
  await mkdir(path.join(root, "docs"), { recursive: true });
  await writeFile(path.join(root, "docs/prd.md"), prd, "utf8");
  await writeFile(path.join(root, "docs/design.md"), design, "utf8");
  // 局部修改的计划只包含改动页面，不能覆盖整站的页面计划。
  if (!keepExisting || !existingSitePlan.trim()) {
    await writeFile(path.join(root, "docs/site-plan.json"), JSON.stringify({ summary: plan.summary, mode: plan.mode, brand: plan.brand, pages: plan.pages, sharedComponents: plan.sharedComponents, acceptanceCriteria: plan.acceptanceCriteria }, null, 2), "utf8");
  }
}

function normalizeReview(value: unknown): SiteReview {
  const source = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const toStrings = (item: unknown) => Array.isArray(item) ? item.filter((entry): entry is string => typeof entry === "string") : [];
  return {
    ok: source.ok !== false,
    score: typeof source.score === "number" ? Math.max(0, Math.min(100, source.score)) : 70,
    blockingIssues: toStrings(source.blockingIssues),
    suggestions: toStrings(source.suggestions),
    evidence: toStrings(source.evidence),
  };
}

export async function reviewSite(apiKey: string, projectId: string, message: string, root: string): Promise<SiteReview> {
  const files = await listWorkspaceFiles(root);
  const relevant = files.filter((file) => file.path === "docs/design.md" || file.path === "src/app/App.tsx" || file.path === "src/app/site-manifest.ts" || file.path === "src/content/site.ts" || file.path.startsWith("src/pages/") || file.path.startsWith("src/content/") || file.path.startsWith("src/components/site/"));
  let sourceBudget = 0;
  const sourceBundle = relevant.map((file) => {
    if (sourceBudget >= 60000) return "";
    const content = file.content.slice(0, Math.min(7000, 60000 - sourceBudget));
    sourceBudget += content.length;
    return `\n--- ${file.path} ---\n${content}`;
  }).join("\n");
  const skillContext = (await loadSiteSkills(root, ["site-review"])).slice(0, 12000);
  const messages: ChatMessage[] = [
    { role: "system", content: `你是网站内容和设计审查 Agent。只做审查，不修改文件。使用 site-review Skill，对 design.md 和实际源码进行证据审查。允许代码 Agent 自由选择布局和内容表达，不要要求照抄模板。示例内容（由 Agent 补全的地址、价格、评价等）是被允许的，不算问题。只有当页面没有完成用户任务、内容明显过薄、关键区块缺失、存在占位文案、页面高度雷同或核心交互缺失时，才列入 blockingIssues，且每条都要写明文件路径。只输出 JSON：{"ok":true,"score":0,"blockingIssues":[],"suggestions":[],"evidence":[]}。${skillContext}` },
    { role: "user", content: `项目 ID：${projectId}\n用户需求：\n${message}\n\n当前项目文件：\n${sourceBundle}` },
  ];
  try {
    const { message: assistant } = await deepSeekRequest(apiKey, messages, { responseFormat: { type: "json_object" }, maxTokens: 8000, purpose: "review" });
    return normalizeReview(JSON.parse(assistant.content || "{}"));
  } catch (error) {
    return { ok: true, score: 0, blockingIssues: [], suggestions: [`质量审查未完成：${error instanceof Error ? error.message : "未知错误"}`], evidence: [] };
  }
}

export type Intent = "new_site" | "modify" | "fix" | "ask";
export type IntentResult = { intent: Intent; summary: string; routes: string[]; reason: string; provider: "jev" | "deepseek" | "heuristic"; confidence?: number; lowConfidence?: boolean };
export type ProjectSnapshot = { isTemplate: boolean; brand: string; routes: Array<{ path: string; label: string }> };

// 项目现状：是否还是模板、品牌名、已有页面。意图识别和修改计划都依赖它。
export async function projectSnapshot(root: string): Promise<ProjectSnapshot> {
  const files = await listWorkspaceFiles(root);
  const manifest = files.find((file) => file.path === "src/app/site-manifest.ts")?.content ?? "";
  const routes = [...manifest.matchAll(/path:\s*["'`]([^"'`]+)["'`]\s*,\s*label:\s*["'`]([^"'`]+)["'`]/g)].map((match) => ({ path: normalizeRoute(match[1]), label: match[2] }));
  const siteContent = files.find((file) => file.path === "src/content/site.ts")?.content ?? "";
  const brand = manifest.match(/brand:\s*["'`]([^"'`]+)["'`]/)?.[1] ?? siteContent.match(/\bname:\s*["'`]([^"'`]+)["'`]/)?.[1] ?? "";
  // 页面还和模板一模一样，说明用户还没有建过站。
  const pages = files.filter((file) => /^src\/pages\/[^/]+\.tsx$/.test(file.path) && file.path !== "src/pages/NotFoundPage.tsx");
  const isTemplate = pages.length === 0 || pages.every((file) => templateFileContent(file.path) === file.content);
  return { isTemplate, brand, routes };
}

function templateFileContent(relativePath: string) {
  return (templateFiles as Record<string, string>)[relativePath];
}

const intentPrompt = `你是 AI 建站 Copilot 的意图识别器。根据用户最新的消息、最近的对话和项目现状，判断这条消息要做什么。

intent 只能取以下之一：
- "new_site"：从零创建或整体重做网站。包括：项目还是空模板时的任何建站需求；要做一个与当前网站不同业务的网站；明确说“重做”“重新做”“从零开始”“换成另一个网站”。
- "modify"：在现有网站上修改或新增：内容、页面、样式、布局、功能、文案。也包括指出具体问题的反馈，例如“首页太空了”“手机上导航错位”“颜色太暗”“加一个会员页”“再高级一点”。
- "fix"：只要求修复构建、预览或报错，或让系统自己检查并修复问题，没有指出具体要改什么。例如“修复构建错误”“预览打不开”“报错了”“检查并修复问题”。
- "ask"：提问、解释或只读检查，不需要修改文件。例如“现在有几个页面”“用了什么配色”“帮我看看有什么问题，先别改”。

要结合最近的对话理解指代（“再深一点”“刚才那个按钮”）。routes 填写这次会涉及的页面路由（只能从已有路由里选，新增页面写计划中的新路由，不确定就留空数组）。

只输出一个 JSON object：{"intent":"modify","summary":"一句话复述用户要做的事","routes":[],"reason":"一句话判断依据"}`;

function heuristicIntent(message: string, snapshot: ProjectSnapshot): Intent {
  if (/只读|仅检查|只检查|审计|仅分析|不要修改|先别改|别改|是什么|有哪些|有几个|多少|为什么|怎么样[？?]?$|吗[？?]?$/.test(message)) return "ask";
  if (snapshot.isTemplate || /重做|重新做|从零|从头|新建一个|换成.*网站/.test(message)) return "new_site";
  if (message.length <= 24 && /修复|报错|打不开|构建失败|白屏|出错/.test(message)) return "fix";
  return "modify";
}

// 意图识别：配置了 TYPESAFE_API_KEY 时先用 Jev（专门做结构化判断，快且给出置信度），
// Jev 不可用或置信度不够时，再用不开深度思考的 DeepSeek 调用判断。
export async function classifyIntent(apiKey: string, message: string, history: string, snapshot: ProjectSnapshot): Promise<IntentResult> {
  const jev = await classifyWithJev(message, history, snapshot);
  if (jev && !jev.lowConfidence) return jev;
  const fallback = await classifyWithDeepSeek(apiKey, message, history, snapshot);
  if (!jev) return fallback;
  return { ...fallback, routes: fallback.routes.length ? fallback.routes : jev.routes, reason: `${jev.reason}，置信度不足，改由 DeepSeek 判断：${fallback.reason}` };
}

async function classifyWithDeepSeek(apiKey: string, message: string, history: string, snapshot: ProjectSnapshot): Promise<IntentResult> {
  const project = snapshot.isTemplate
    ? "项目还是初始模板，尚未建站。"
    : `当前网站：${snapshot.brand || "未命名"}；已有页面：${snapshot.routes.map((route) => `${route.label}（${route.path}）`).join("、") || "无"}`;
  try {
    const { message: reply } = await deepSeekRequest(apiKey, [
      { role: "system", content: intentPrompt },
      { role: "user", content: `项目现状：${project}${history ? `\n\n最近对话：\n${history}` : ""}\n\n用户最新消息：\n${message}` },
    ], { thinking: { type: "disabled" }, responseFormat: { type: "json_object" }, maxTokens: 600, purpose: "intent" });
    const parsed = JSON.parse(reply.content || "{}") as Record<string, unknown>;
    const intents: Intent[] = ["new_site", "modify", "fix", "ask"];
    let intent = intents.includes(parsed.intent as Intent) ? parsed.intent as Intent : heuristicIntent(message, snapshot);
    // 还没建过站时，除了提问之外都只能是新建。
    if (snapshot.isTemplate && intent !== "ask") intent = "new_site";
    const known = new Set(snapshot.routes.map((route) => route.path));
    const routes = stringArray(parsed.routes).map(normalizeRoute).filter((route) => intent !== "modify" || known.has(route) || /^\/[a-z0-9-/]*$/.test(route));
    return { intent, summary: String(parsed.summary || message).slice(0, 200), routes, reason: `DeepSeek：${String(parsed.reason || intent)}`, provider: "deepseek" };
  } catch {
    return { intent: heuristicIntent(message, snapshot), summary: message.slice(0, 200), routes: [], reason: "意图识别调用失败，按关键词判断", provider: "heuristic" };
  }
}

// 局部修改不重新规划，用意图识别的结果拼一个轻量计划，供修改 Agent 预读相关页面。
export function planFromIntent(result: IntentResult, snapshot: ProjectSnapshot): SitePlan {
  const labels = new Map(snapshot.routes.map((route) => [route.path, route.label]));
  return normalizePlan({
    summary: result.summary,
    mode: "modify_site",
    readOnly: result.intent === "ask",
    brand: { name: snapshot.brand },
    pages: result.routes.map((route) => ({ name: labels.get(route) || route, route, goal: result.summary })),
  });
}

// 规划拆成三次调用：小的结构化 JSON（页面计划）+ 两份纯 Markdown 文档。
// 之前把长文档塞进 JSON 字段，输出一被截断整个计划就解析失败。
export async function createPlan(apiKey: string, projectId: string, message: string, root?: string, onStage?: (label: string) => Promise<void> | void, options: { forceNewSite?: boolean; history?: string } = {}) {
  const [previousPrd, previousDesign, manifest] = root ? await Promise.all([readOptionalFile(root, "docs/prd.md"), readOptionalFile(root, "docs/design.md"), readOptionalFile(root, "src/app/site-manifest.ts")]) : ["", "", ""];
  const projectSummary = root ? JSON.stringify(await listWorkspaceSummaries(root)) : "尚未初始化项目";
  enterStage("plan");
  await onStage?.("正在规划网站结构和页面");
  const sitemap = await requestJson(apiKey, [
    { role: "system", content: `${sitemapPrompt}${await loadSiteSkills(root, ["requirements"])}` },
    { role: "user", content: `项目 ID：${projectId}\n当前项目文件摘要：\n${projectSummary}\n\n当前路由清单：\n${manifest || "无"}\n\n已有 PRD（节选）：\n${previousPrd.slice(0, 6000) || "无"}${options.history ? `\n\n最近对话：\n${options.history}` : ""}\n\n用户需求：\n${message}` },
  ], 16000, "plan");
  const plan = normalizePlan(sitemap);
  // 意图识别已经确定是新建网站时，不让规划模型再改判成局部修改。
  if (options.forceNewSite) { plan.mode = "new_site"; plan.readOnly = false; }
  if (plan.mode === "new_site" && plan.pages.length === 0) throw new Error("需求规划没有给出页面清单，请重试或把需求描述得更具体一些");
  if (plan.readOnly) return plan;
  // 局部修改沿用已有文档，避免一次小改动重写整份 PRD 和设计规范。
  if (plan.mode === "modify_site" && previousPrd.trim() && previousDesign.trim()) return plan;

  const planJson = JSON.stringify({ summary: plan.summary, brand: plan.brand, pages: plan.pages }, null, 2);
  enterStage("prd");
  await onStage?.("正在使用需求 Skill 编写 PRD");
  const prdMarkdown = await requestMarkdown(apiKey, [
    { role: "system", content: `${prdPrompt}\n\n${contentPolicy}${await loadSiteSkills(root, ["requirements"])}` },
    { role: "user", content: `项目 ID：${projectId}\n用户需求：\n${message}\n\n页面规划：\n${planJson}` },
  ], 16000, "prd").catch(() => "");
  enterStage("design");
  await onStage?.("PRD 已完成，正在使用设计 Skill 推导 design.md");
  const designMarkdown = await requestMarkdown(apiKey, [
    { role: "system", content: `${designPrompt}\n\n${contentPolicy}${await loadSiteSkills(root, ["design-derivation"])}` },
    { role: "user", content: `项目 ID：${projectId}\n用户需求：\n${message}\n\n页面规划：\n${planJson}\n\nPRD：\n${prdMarkdown || fallbackPrd(message, plan)}` },
  ], 20000, "design").catch(() => "");
  return { ...plan, prdMarkdown, designMarkdown };
}

type WriteScope = { description: string; allows: (relativePath: string) => boolean };

function normalizeToolPath(value: unknown) {
  return String(value ?? "").replaceAll("\\", "/").replace(/^\.?\/+/, "");
}

type ReadScope = { reason: string; allows: (relativePath: string) => boolean };

async function executeTool(name: string, args: Record<string, unknown>, root: string, scope?: WriteScope, readScope?: ReadScope) {
  if (name === "read_file" && readScope && !readScope.allows(normalizeToolPath(args.path))) {
    throw new Error(`不需要读取 ${normalizeToolPath(args.path)}：${readScope.reason}`);
  }
  if ((name === "apply_patch" || name === "write_file") && scope && !scope.allows(normalizeToolPath(args.path))) {
    throw new Error(`当前阶段不允许修改 ${normalizeToolPath(args.path)}。只允许修改：${scope.description}`);
  }
  if (name === "list_files") return JSON.stringify(await listWorkspaceSummaries(root));
  if (name === "read_file") return await readFile(safeWorkspacePath(root, String(args.path ?? "")), "utf8");
  if (name === "search_code") return JSON.stringify(await searchWorkspace(root, String(args.query ?? "")));
  if (name === "apply_patch") return JSON.stringify(await applyWorkspacePatch(root, String(args.path ?? ""), String(args.find ?? ""), String(args.replace ?? "")));
  if (name === "write_file") {
    const relativePath = normalizeToolPath(args.path);
    const target = safeWorkspacePath(root, relativePath);
    const content = String(args.content ?? "");
    if (!content.trim()) throw new Error("文件内容不能为空。如果内容很长，可能是输出被截断了，请把文件拆小后分别写入");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
    return `已写入 ${relativePath}`;
  }
  if (name === "check_project") return JSON.stringify(await checkWorkspace(root));
  if (name === "check_content") return JSON.stringify(inspectContentQuality(await listWorkspaceFiles(root)));
  throw new Error(`未知工具：${name}`);
}

type AgentOptions = {
  apiKey: string;
  root: string;
  emit: WorkflowEmitter;
  system: string;
  user: string;
  tools: readonly ToolDefinition[];
  maxTurns: number;
  tag?: string;
  scope?: WriteScope;
  readScope?: ReadScope;
  verify?: () => Promise<string[]>;
  maxVerifyRounds?: number;
  // 轮数快用完时，提醒 Agent 必须先写出的文件（例如页面文件本身）
  mustWrite?: string;
};

type AgentOutcome = { reply: string; events: string[]; toolCallCount: number; remainingIssues: string[] };

// 通用的工具调用循环。Agent 结束回复后由系统运行 verify，而不是依赖模型
// 记得调用检查工具；发现问题就在同一段对话里继续修复，保留已有上下文。
async function runAgent(options: AgentOptions): Promise<AgentOutcome> {
  const run = currentRun();
  // 同名 Agent（例如多轮“修复”）在报告里加序号区分。
  const baseName = options.tag || "agent";
  const agentName = run && run.agents.some((agent) => agent.agent === baseName) ? `${baseName}#${run.agents.filter((agent) => agent.agent.split("#")[0] === baseName).length + 1}` : baseName;
  return withScope({ agent: agentName }, () => runAgentLoop(options, agentName));
}

async function runAgentLoop(options: AgentOptions, agentName: string): Promise<AgentOutcome> {
  const run = currentRun();
  const scope = currentScope();
  const record: AgentRecord = { agent: agentName, stage: scope.stage, startedMs: run?.now() ?? 0, ms: 0, turns: 0, maxTurns: options.maxTurns, toolCalls: 0, failedToolCalls: 0, verifyRounds: 0, endedBy: "turn_limit", remainingIssues: [], promptTokensByTurn: [], writtenFiles: {} };
  const started = Date.now();
  const prefix = options.tag ? `${options.tag} · ` : "";
  const canWrite = options.tools.some((tool) => tool.function.name === "write_file");
  // 基线运行里 15 个 Agent 全部把轮数用完才停：一直在读文件、在思考里起草整页代码，
  // 最后来不及写。所以一开始就告诉它预算，快用完时明确要求停止阅读、立即写入。
  const budget = canWrite
    ? `\n\n# 轮次预算\n你最多有 ${options.maxTurns} 轮对话。每一轮都可以同时调用多个工具（例如一次读取多个文件、一次写入多个文件），请合并调用。需要的文件大多已经附在消息里，不要为了“参考写法”去读其他文件。最迟第 2 轮开始写文件${options.mustWrite ? `，并且最先写出 ${options.mustWrite}` : ""}。思考只用来规划结构，不要在思考里起草完整代码，代码直接写进 write_file。`
    : `\n\n# 轮次预算\n你最多有 ${options.maxTurns} 轮对话，每一轮都可以同时调用多个工具。`;
  const messages: ChatMessage[] = [{ role: "system", content: `${options.system}${budget}` }, { role: "user", content: options.user }];
  const events: string[] = [];
  let reply = "";
  let toolCallCount = 0;
  let verifyRounds = 0;
  let remainingIssues: string[] = [];
  let finished = false;
  let turnLimit = options.maxTurns;
  const verify = async () => {
    if (!options.verify) return [];
    const verifyStarted = Date.now();
    const issues = await options.verify();
    run?.verifies.push({ agent: agentName, round: verifyRounds + 1, ms: Date.now() - verifyStarted, issues });
    return issues;
  };
  try {
    for (let turn = 0; turn < turnLimit; turn += 1) {
      record.turns = turn + 1;
      const { message: assistant, usage, finishReason } = await withScope({ turn: turn + 1 }, () => deepSeekRequest(options.apiKey, messages, { tools: options.tools, maxTokens: 32000, purpose: "agent_turn" }));
      record.promptTokensByTurn.push(usage?.prompt_tokens ?? 0);
      messages.push(assistant);
      if (!assistant.tool_calls?.length) {
        reply = assistant.content?.trim() || reply;
        if (!options.verify) { finished = true; record.endedBy = "reply"; break; }
        remainingIssues = await verify();
        if (!remainingIssues.length) { finished = true; record.endedBy = "reply"; break; }
        if (verifyRounds >= (options.maxVerifyRounds ?? 2)) { finished = true; record.endedBy = "verify_limit"; break; }
        verifyRounds += 1;
        turnLimit = Math.max(turnLimit, turn + 1 + 6);
        await options.emit({ type: "verify_failed", label: `${prefix}自动检查发现 ${remainingIssues.length} 个问题，继续修复`, error: remainingIssues.slice(0, 3).join("；") });
        messages.push({ role: "user", content: `自动检查发现以下问题，请继续修复，全部修复后再结束回复：\n${remainingIssues.map((issue) => `- ${issue}`).join("\n")}` });
        continue;
      }
      for (const call of assistant.tool_calls) {
        toolCallCount += 1;
        const args = parseArgs(call.function.arguments);
        const label = `${prefix}${call.function.name} · ${String(args.path ?? args.query ?? "项目")}`;
        const path = typeof args.path === "string" ? normalizeToolPath(args.path) : undefined;
        await options.emit({ type: "tool_started", name: call.function.name, label });
        const toolStarted = Date.now();
        try {
          const result = await executeTool(call.function.name, args, options.root, options.scope, options.readScope);
          events.push(label);
          run?.tools.push({ agent: agentName, stage: scope.stage, name: call.function.name, path, ok: true, ms: Date.now() - toolStarted, argChars: call.function.arguments.length, resultChars: result.length });
          if (path && (call.function.name === "write_file" || call.function.name === "apply_patch")) record.writtenFiles[path] = (record.writtenFiles[path] ?? 0) + 1;
          await options.emit({ type: "tool_completed", name: call.function.name, label });
          messages.push({ role: "tool", tool_call_id: call.id, content: result });
        } catch (error) {
          const detail = error instanceof Error ? error.message : "工具执行失败";
          record.failedToolCalls += 1;
          run?.tools.push({ agent: agentName, stage: scope.stage, name: call.function.name, path, ok: false, ms: Date.now() - toolStarted, argChars: call.function.arguments.length, resultChars: 0, error: detail.slice(0, 300) });
          events.push(`${prefix}${call.function.name} · 失败`);
          await options.emit({ type: "tool_failed", name: call.function.name, label: `${prefix}${call.function.name} · 失败`, error: detail });
          messages.push({ role: "tool", tool_call_id: call.id, content: `工具错误：${detail}` });
        }
      }
      const notes: string[] = [];
      if (finishReason === "length") notes.push("上一次输出超过长度上限被截断，写入的文件内容可能不完整。请把大文件拆成几个较小的文件分别写入，并检查刚才的写入是否成功。");
      const remaining = turnLimit - (turn + 1);
      if (canWrite && remaining > 0 && remaining <= 3) {
        const target = options.mustWrite ? `尚未完成的文件（优先 ${options.mustWrite}）` : "尚未完成的修改";
        notes.push(remaining === 1
          ? `这是最后一轮。必须现在用 write_file 写出${target}，写完就结束回复，不要再读取任何文件。`
          : `还剩 ${remaining} 轮。停止阅读，下一轮必须用 write_file 写出${target}。`);
      }
      if (notes.length) messages.push({ role: "user", content: notes.join("\n") });
    }
    if (!finished && options.verify) remainingIssues = await verify();
    return { reply, events, toolCallCount, remainingIssues };
  } catch (error) {
    record.endedBy = "error";
    record.error = error instanceof Error ? error.message.slice(0, 300) : String(error);
    throw error;
  } finally {
    record.ms = Date.now() - started;
    record.toolCalls = toolCallCount;
    record.verifyRounds = verifyRounds;
    record.remainingIssues = remainingIssues;
    if (run) { run.agents.push(record); run.transcripts[agentName] = messages; }
  }
}

// 代码自动修复，并把修了什么记进运行报告。
export async function applyAutoFixes(root: string, stage: string) {
  const fixes = await autoFixProject(root).catch(() => [] as string[]);
  if (fixes.length) currentRun()?.autofixes.push({ stage, fixes });
  return fixes;
}

async function mapLimit<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>) {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await task(items[index]); }
  }));
  return results;
}

async function typeErrors(projectId: string, root: string, matches: (line: string) => boolean) {
  const result = await typecheckWorkspace(projectId, root);
  if (!result || result.ok) return [];
  return result.output.split(/\r?\n/).filter((line) => /error TS\d+/.test(line) && matches(line)).slice(0, 15).map((line) => `TypeScript：${line.trim()}`);
}

type ExecutionContext = { apiKey: string; projectId: string; message: string; plan: SitePlan; root: string; emit: WorkflowEmitter; history?: string };

function historyBlock(history?: string) {
  return history ? `\n\n# 最近对话（用于理解“刚才那个”“再改一点”这类指代）\n${history}` : "";
}

function routeListOf(pages: PlannedPage[]) {
  return pages.map((page) => `${page.route}（${page.name}）`).join("、");
}

async function runFoundation(context: ExecutionContext, planned: PlannedPage[]) {
  const { apiKey, projectId, message, plan, root, emit } = context;
  const routes = planned.map((page) => page.route);
  const design = await readOptionalFile(root, "docs/design.md");
  const files = await fileBundle(root, ["src/app/site-manifest.ts", "src/app/App.tsx", "src/components/site/Header.tsx", "src/components/site/Footer.tsx", "src/layouts/SiteLayout.tsx", "src/styles/tokens.css", "src/styles/globals.css", "design/tokens.json", "index.html", "src/components/site/PageHero.tsx", "src/components/site/ContentCard.tsx", "src/components/ui/Section.tsx", "src/components/ui/Container.tsx", "src/components/ui/Button.tsx", "src/app/router.tsx"], 16000);
  const allowed = ["src/styles/tokens.css", "src/styles/globals.css", "design/tokens.json", "src/app/site-manifest.ts", "src/content/site.ts", "index.html", "docs/content-todo.md"];
  const scope: WriteScope = {
    description: `${allowed.join("、")}、src/layouts/、src/components/（不含 sections/）`,
    allows: (file) => allowed.includes(file) || file.startsWith("src/layouts/") || (file.startsWith("src/components/") && !file.startsWith("src/components/sections/")),
  };
  const verify = async () => {
    await applyAutoFixes(root, "verify:全站基础");
    const current = await listWorkspaceFiles(root);
    const paths = new Set(current.map((file) => file.path));
    const issues = analyzeProject(current).filter((issue) => issue.severity === "error" && !issue.file.startsWith("src/pages/")).map((issue) => issue.message);
    const declared = new Set(manifestRoutes(current));
    for (const route of routes) if (!declared.has(route)) issues.push(`site-manifest.ts 缺少路由 ${route}，不能删除计划中的页面路由`);
    if (!paths.has("src/content/site.ts")) issues.push("还没有创建 src/content/site.ts（全站共用事实）");
    if (!paths.has("docs/content-todo.md")) issues.push("还没有创建 docs/content-todo.md（示例内容清单）");
    issues.push(...await typeErrors(projectId, root, (line) => !line.startsWith("src/pages/")));
    return issues;
  };
  const readScope: ReadScope = {
    reason: "页面文件目前只是骨架，由后续的页面 Agent 实现；需要的文件已经附在消息里。",
    allows: (file) => !file.startsWith("src/pages/") && !file.startsWith("skills/") && file !== "AGENT.md",
  };
  return runAgent({
    apiKey, root, emit, scope, readScope, verify,
    tag: "全站基础",
    tools: focusedTools,
    maxTurns: 10,
    mustWrite: "src/styles/globals.css、src/content/site.ts、Header 和 Footer",
    system: `${foundationPrompt}\n\n${contentPolicy}`,
    user: `项目 ID：${projectId}\n用户需求：\n${message}\n\n网站计划：\n${JSON.stringify({ summary: plan.summary, brand: plan.brand, pages: planned.map((page) => ({ name: page.name, route: page.route, file: page.file, goal: page.goal })) }, null, 2)}\n\n已注册路由：${routeListOf(planned)}\n\n# docs/design.md\n${truncate(design, 24000)}\n\n# 当前文件\n${files}`,
  });
}

async function runPage(context: ExecutionContext, page: PlannedPage, planned: PlannedPage[]) {
  const { apiKey, projectId, message, plan, root, emit } = context;
  const design = await readOptionalFile(root, "docs/design.md");
  const pagePlan = plan.pages.find((item) => normalizeRoute(item.route) === page.route);
  const summaries = await listWorkspaceSummaries(root);
  const sharedComponents = summaries.filter((file) => file.path.startsWith("src/components/") && !file.path.startsWith("src/components/sections/")).map((file) => file.path);
  // 完整附上页面需要的共享文件（基线里 site.ts 被截断，Agent 只好一遍遍重新读取）
  const files = await fileBundle(root, [page.file, "src/content/site.ts", "src/styles/tokens.css", "src/app/router.tsx", ...sharedComponents.filter((file) => !file.endsWith("Header.tsx") && !file.endsWith("Footer.tsx"))], 40000);
  const globals = await readOptionalFile(root, "src/styles/globals.css");
  const prefix = page.component.replace(/Page$/, "");
  const owned = (file: string) => file === page.file || file.startsWith(`src/content/${page.slug}`) || file === `src/styles/pages/${page.slug}.css` || file.startsWith(`src/components/sections/${prefix}`);
  const scope: WriteScope = { description: `${page.file}、src/content/${page.slug}*.ts、src/styles/pages/${page.slug}.css、src/components/sections/${prefix}*.tsx`, allows: owned };
  const readScope: ReadScope = {
    reason: "其他页面由别的 Agent 并行实现，不要参考它们；需要的共享文件已经附在消息里。",
    allows: (file) => owned(file) || file === "src/content/site.ts" || file === "src/app/router.tsx" || file === "src/app/site-manifest.ts" || file.startsWith("src/components/") || file.startsWith("src/styles/") || file.startsWith("docs/"),
  };
  const verify = async () => {
    await applyAutoFixes(root, `verify:${page.name}`);
    const issues = pageIssues(await listWorkspaceFiles(root), page.file);
    issues.push(...await typeErrors(projectId, root, (line) => owned(line.split("(")[0])));
    return issues;
  };
  return runAgent({
    apiKey, root, emit, scope, readScope, verify,
    tag: page.name,
    tools: focusedTools,
    maxTurns: 8,
    mustWrite: page.file,
    system: `${pagePrompt(page, routeListOf(planned))}\n\n${contentPolicy}`,
    user: `项目 ID：${projectId}\n用户需求：\n${message}\n\n# 本页计划\n${JSON.stringify({ ...pagePlan, route: page.route, file: page.file }, null, 2)}\n\n# design.md（全局部分 + 本页蓝图）\n${designExcerpt(design, page.route)}\n\n# globals.css 中已有的类名（可以直接使用）\n${cssClassSummary(globals)}\n\n# 当前文件\n${files}`,
  });
}

async function runPages(context: ExecutionContext, pages: PlannedPage[], planned: PlannedPage[]) {
  const outcomes = await mapLimit(pages, PAGE_CONCURRENCY, async (page) => {
    await context.emit({ type: "stage", stage: "page", label: `正在实现页面：${page.name}（${page.route}）` });
    try {
      const outcome = await runPage(context, page, planned);
      await context.emit({ type: "page_done", ok: outcome.remainingIssues.length === 0, label: outcome.remainingIssues.length ? `${page.name} 已完成，还有 ${outcome.remainingIssues.length} 个问题留给整站修复` : `${page.name} 已完成` });
      return { page, outcome };
    } catch (error) {
      // 单个页面失败不影响其他页面；整站校验会发现剩下的骨架页并交给修复阶段。
      const detail = error instanceof Error ? error.message : "页面生成失败";
      await context.emit({ type: "page_done", ok: false, label: `${page.name} 生成失败：${detail}`, error: detail });
      return { page, outcome: { reply: "", events: [], toolCallCount: 0, remainingIssues: [detail] } as AgentOutcome };
    }
  });
  return outcomes;
}

// 新建网站：代码生成路由骨架 → 全站基础 Agent → 页面 Agent 并行实现。
// 每个 Agent 只拿到自己需要的上下文和写入权限，轮数不会被其他页面耗尽。
async function executeNewSite(context: ExecutionContext) {
  const { plan, root, emit } = context;
  enterStage("scaffold");
  const planned = await scaffoldSite(root, plan.brand?.name || "", plan.pages);
  await emit({ type: "stage", stage: "scaffold", label: `已创建 ${planned.length} 个页面骨架并注册路由：${planned.map((page) => page.name).join("、")}` });
  enterStage("foundation");
  await emit({ type: "stage", stage: "foundation", label: "正在搭建全站基础：设计令牌、导航页脚和共享内容" });
  const foundation = await runFoundation(context, planned);
  enterStage("pages");
  await emit({ type: "stage", stage: "pages", label: `全站基础完成，开始并行实现 ${planned.length} 个页面` });
  const pages = await runPages(context, planned, planned);
  const pageLines = pages.map(({ page, outcome }) => `- ${page.name}（${page.route}）：${outcome.reply.split("\n")[0]?.slice(0, 120) || (outcome.remainingIssues.length ? "未完全完成" : "已完成")}`);
  return {
    reply: `${foundation.reply || "已完成全站基础。"}\n\n${pageLines.join("\n")}`,
    events: [...foundation.events, ...pages.flatMap(({ outcome }) => outcome.events)],
    toolCallCount: foundation.toolCallCount + pages.reduce((total, { outcome }) => total + outcome.toolCallCount, 0),
  };
}

async function projectVerify(projectId: string, root: string) {
  await applyAutoFixes(root, "verify:修复");
  const issues = analyzeProject(await listWorkspaceFiles(root)).filter((issue) => issue.severity === "error").map((issue) => issue.message);
  issues.push(...await typeErrors(projectId, root, () => true));
  return issues.slice(0, 30);
}

async function changeContext(root: string, extraFiles: string[] = []) {
  const summaries = await listWorkspaceSummaries(root);
  const design = await readOptionalFile(root, "docs/design.md");
  const files = await fileBundle(root, [...new Set(["src/app/site-manifest.ts", "src/app/App.tsx", "src/content/site.ts", "docs/content-todo.md", ...extraFiles])], 12000);
  return `# 项目文件\n${summaries.map((file) => `${file.path} (${file.bytes}B)`).join("\n")}\n\n# docs/design.md\n${truncate(design, 14000)}\n\n# 当前文件\n${files}`;
}

async function executeChange(context: ExecutionContext) {
  const { apiKey, projectId, message, plan, root, emit, history } = context;
  const pageFiles = planPages(plan.pages).map((page) => page.file);
  return runAgent({
    apiKey, root, emit,
    tag: "修改",
    tools: authoringTools,
    maxTurns: 16,
    system: `${executionPrompt}\n\n${contentPolicy}\n\n本次修改计划：\n${JSON.stringify({ summary: plan.summary, pages: plan.pages }, null, 2)}`,
    user: `项目 ID：${projectId}\n用户需求：\n${message}${historyBlock(history)}\n\n${await changeContext(root, pageFiles)}`,
    verify: () => projectVerify(projectId, root),
  });
}

// 修复按“先便宜后昂贵”的顺序升级：
// 1. 代码自动修复（零成本）
// 2. 仍是骨架的页面：重跑该页面 Agent（它有完整的页面上下文，比通用修复可靠）
// 3. 重新检查，只把真正剩下的问题和相关文件的完整内容交给修复 Agent；没剩下就不调用模型
async function executeRepair(context: ExecutionContext, repairMessage: string) {
  const { apiKey, projectId, message, root, emit, history } = context;
  const events: string[] = [];
  let toolCallCount = 0;
  const fixes = await applyAutoFixes(root, "repair");
  if (fixes.length) await emit({ type: "autofix", label: `代码自动修复了 ${fixes.length} 个问题`, error: fixes.slice(0, 3).join("；") });

  const files = await listWorkspaceFiles(root);
  const planned = planPages(manifestRoutes(files).map((route) => ({ route, name: route, goal: "" })));
  const manifest = files.find((file) => file.path === "src/app/site-manifest.ts")?.content ?? "";
  for (const page of planned) {
    const label = manifest.match(new RegExp(`path:\\s*["'\`]${page.route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'\`]\\s*,\\s*label:\\s*["'\`]([^"'\`]+)`))?.[1];
    const planPage = context.plan.pages.find((item) => normalizeRoute(item.route) === page.route);
    page.name = planPage?.name || label || page.route;
    page.goal = planPage?.goal || "";
  }
  const stubPages = planned.filter((page) => files.find((file) => file.path === page.file)?.content.includes(STUB_MARKER));
  if (stubPages.length) {
    const outcomes = await runPages(context, stubPages, planned);
    for (const { outcome } of outcomes) { events.push(...outcome.events); toolCallCount += outcome.toolCallCount; }
  }

  // 静态检查、类型检查和构建都可以立刻重跑；浏览器检查和内容审查的问题只能沿用上一轮的结论。
  const current = await projectVerify(projectId, root);
  const build = await syncWorkspaceToPreview(projectId, root).then(() => validatePreview(projectId)).catch(() => ({ ok: true } as ValidationResult));
  const buildIssues = !build.ok && !/TypeScript 检查失败/.test(build.error ?? "") ? [`构建失败：${String(build.error ?? "").replace(/\x1b\[[0-9;]*m/g, "").slice(0, 1500)}`] : [];
  const carried = repairMessage.split("\n").map((line) => line.replace(/^-\s*/, "").trim()).filter((line) => /^路由 |^内容审查：/.test(line));
  const remaining = [...current, ...buildIssues, ...carried];
  if (!remaining.length) {
    return { reply: stubPages.length ? `已重新生成 ${stubPages.map((page) => page.name).join("、")}，检查通过。` : "代码自动修复后检查通过。", events, toolCallCount };
  }
  const implicated = [...new Set(remaining.join("\n").match(/src\/[\w./-]+\.(?:tsx?|css)/g) ?? [])].slice(0, 6);
  const outcome = await runAgent({
    apiKey, root, emit,
    tag: "修复",
    tools: focusedTools,
    maxTurns: 8,
    mustWrite: implicated.slice(0, 3).join("、") || undefined,
    system: `你是建站项目的修复 Agent。只修复下面列出的问题，不要重写没有问题的内容，不要改动与问题无关的文件。出问题的文件已经完整附在消息里，直接修改；第 3 轮之前必须完成写入。小改动用 apply_patch，大面积修改用 write_file。\n\n${contentPolicy}`,
    user: `项目 ID：${projectId}\n原始需求：\n${message}${historyBlock(history)}\n\n# 需要修复的问题\n${remaining.map((issue) => `- ${issue}`).join("\n")}\n\n# 相关文件\n${await fileBundle(root, [...implicated, "src/app/site-manifest.ts", "src/app/App.tsx"], 40000)}`,
    verify: () => projectVerify(projectId, root),
  });
  return { reply: outcome.reply, events: [...events, ...outcome.events], toolCallCount: toolCallCount + outcome.toolCallCount };
}

async function executeAudit(context: ExecutionContext) {
  const { apiKey, projectId, message, root, emit, history } = context;
  return runAgent({
    apiKey, root, emit,
    tag: "只读检查",
    tools: readOnlyTools,
    maxTurns: 12,
    system: "你是建站 Copilot，现在只回答用户的问题或做只读检查。只能调用 list_files、read_file、search_code、check_project、check_content，绝对不要修改项目文件。先读取相关源码和文档再回答，结论要有文件证据，用简洁的中文回复。如果用户其实希望你修改网站，回答完后提醒他直接说出要怎么改。",
    user: `项目 ID：${projectId}\n用户的问题：\n${message}${historyBlock(history)}\n\n${await changeContext(root)}`,
  });
}

export async function executePlan({ apiKey, projectId, message, plan, root, emit, repairMessage, readOnly = false, history }: { apiKey: string; projectId: string; message: string; plan: SitePlan; root: string; emit: WorkflowEmitter; repairMessage?: string; readOnly?: boolean; history?: string }) {
  const context: ExecutionContext = { apiKey, projectId, message, plan, root, emit, history };
  const result = readOnly
    ? await executeAudit(context)
    : repairMessage
      ? await executeRepair(context, repairMessage)
      : plan.mode === "new_site"
        ? await executeNewSite(context)
        : await executeChange(context);
  const files = await listWorkspaceFiles(root);
  const lastCheck = await checkWorkspace(root);
  return {
    reply: result.reply || "已完成项目更新。",
    events: result.events,
    toolCallCount: result.toolCallCount,
    lastCheck,
    lastContentCheck: inspectContentQuality(files),
    checked: true,
  };
}
