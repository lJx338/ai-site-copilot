import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { applyWorkspacePatch, checkWorkspace, ensureWorkspace, inspectContentQuality, listWorkspaceFiles, listWorkspaceSummaries, projectRoot, safeWorkspacePath, searchWorkspace } from "@/lib/project-workspace";

export const runtime = "nodejs";

type ChatMessage = { role: string; content?: string | null; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>; tool_call_id?: string };

const tools = [
  { type: "function", function: { name: "list_files", description: "列出当前 React 项目所有可编辑文件和大小。", parameters: { type: "object", properties: {}, additionalProperties: false } } },
  { type: "function", function: { name: "read_file", description: "读取一个项目文件，修改前必须先读取相关文件。", parameters: { type: "object", properties: { path: { type: "string", description: "项目相对路径，例如 src/pages/MenuPage.tsx" } }, required: ["path"], additionalProperties: false } } },
  { type: "function", function: { name: "search_code", description: "在项目源码中搜索组件名、路由、文案或样式变量。", parameters: { type: "object", properties: { query: { type: "string", description: "要搜索的文本" } }, required: ["query"], additionalProperties: false } } },
  { type: "function", function: { name: "apply_patch", description: "对一个已读取的文件做精确的单处文本补丁，避免重写整页。", parameters: { type: "object", properties: { path: { type: "string" }, find: { type: "string", description: "要替换的完整上下文" }, replace: { type: "string", description: "替换后的内容" } }, required: ["path", "find", "replace"], additionalProperties: false } } },
  { type: "function", function: { name: "write_file", description: "创建新文件或在补丁无法表达时完整写入文件。不能写入环境变量、依赖目录或构建产物。", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string", description: "完整文件内容" } }, required: ["path", "content"], additionalProperties: false } } },
  { type: "function", function: { name: "check_project", description: "检查项目骨架、公共布局、设计令牌和页面组件复用情况。提交修改前必须调用。", parameters: { type: "object", properties: {}, additionalProperties: false } } },
  { type: "function", function: { name: "check_content", description: "检查 PRD、design.md、页面内容密度和模板占位文案。提交修改前必须调用。", parameters: { type: "object", properties: {}, additionalProperties: false } } },
] as const;

const systemPrompt = `你是一个真实的网站建站 Agent，运行在一个可持续修改的 React + TypeScript 项目工作区中。
你的工作目标是把用户的自然语言需求落实为可持续维护的真实网站代码。

工作规则：
1. 每次接到需求必须先调用 list_files，再读取 AGENT.md、skills/requirements/SKILL.md、skills/design-derivation/SKILL.md、skills/site-review/SKILL.md、docs/prd.md、docs/design.md、docs/site-plan.json、design/tokens.json、src/app/site-manifest.ts 和相关页面。
2. 优先使用 search_code 定位现有组件和文案，再使用 apply_patch 做精确修改。只有新增文件或补丁无法表达时才使用 write_file。
3. 公共 Header、Footer、路由、设计令牌和基础组件必须复用。新增页面要接入 App.tsx 与 site-manifest.ts。
4. 不要在页面中重新发明颜色、间距、圆角和阴影；优先使用 src/styles/tokens.css 的变量。
5. 用户提出修改时，只修改必要文件，保留未涉及的页面和公共层。
6. 写完代码后必须调用 check_project 和 check_content；如果检查有错误，继续修复，直到检查通过。
7. 不要把代码贴在最终回复里。工具调用完成后，用简短中文说明完成了什么以及修改了哪些文件。`;

function parseArgs(raw: string) {
  try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
}

async function executeTool(name: string, args: Record<string, unknown>, root: string) {
  if (name === "list_files") return JSON.stringify(await listWorkspaceSummaries(root));
  if (name === "read_file") return await readFile(safeWorkspacePath(root, String(args.path ?? "")), "utf8");
  if (name === "search_code") return JSON.stringify(await searchWorkspace(root, String(args.query ?? "")));
  if (name === "apply_patch") return JSON.stringify(await applyWorkspacePatch(root, String(args.path ?? ""), String(args.find ?? ""), String(args.replace ?? "")));
  if (name === "write_file") {
    const relativePath = String(args.path ?? "");
    const target = safeWorkspacePath(root, relativePath);
    const content = String(args.content ?? "");
    if (!content.trim()) throw new Error("文件内容不能为空");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
    return `已写入 ${relativePath}`;
  }
  if (name === "check_project") return JSON.stringify(await checkWorkspace(root));
  if (name === "check_content") return JSON.stringify(inspectContentQuality(await listWorkspaceFiles(root)));
  throw new Error(`未知工具：${name}`);
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { message?: unknown; projectId?: unknown; apiKey?: unknown };
    const message = String(body.message ?? "").trim();
    const projectId = String(body.projectId ?? "coffee-studio");
    const requestApiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    const apiKey = requestApiKey || process.env.DEEPSEEK_API_KEY || "";
    if (!message) return NextResponse.json({ error: "请输入建站需求" }, { status: 400 });
    if (!apiKey) return NextResponse.json({ error: "请先在右侧输入 DeepSeek API Key。" }, { status: 503 });

    const root = projectRoot(projectId);
    await ensureWorkspace(root);
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: `项目 ID：${projectId}\n用户需求：\n${message}` },
    ];
    const events: string[] = [];
    let reply = "已完成项目更新。";
    let lastCheck: unknown = null;

    for (let turn = 0; turn < 12; turn += 1) {
      const response = await fetch(`${process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com"}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: process.env.DEEPSEEK_MODEL || "deepseek-flash", temperature: 0.15, messages, tools, tool_choice: "auto" }),
      });
      if (!response.ok) {
        const detail = await response.text();
        return NextResponse.json({ error: `DeepSeek 请求失败：${detail.slice(0, 320)}` }, { status: 502 });
      }
      const raw = await response.text();
      if (!raw.trim()) return NextResponse.json({ error: "DeepSeek 返回了空响应，请检查 API Key 和模型配置。" }, { status: 502 });
      let payload: { model?: string; choices?: Array<{ message?: ChatMessage }> };
      try { payload = JSON.parse(raw) as { model?: string; choices?: Array<{ message?: ChatMessage }> }; } catch { return NextResponse.json({ error: `DeepSeek 返回的不是 JSON：${raw.slice(0, 220)}` }, { status: 502 }); }
      const assistant = payload.choices?.[0]?.message;
      if (!assistant) return NextResponse.json({ error: "DeepSeek 没有返回有效内容" }, { status: 502 });
      messages.push(assistant);
      if (!assistant.tool_calls?.length) { reply = assistant.content?.trim() || reply; break; }
      for (const call of assistant.tool_calls) {
        const args = parseArgs(call.function.arguments);
        try {
          const result = await executeTool(call.function.name, args, root);
          if (call.function.name === "check_project") lastCheck = JSON.parse(result);
          events.push(`${call.function.name} · ${String(args.path ?? args.query ?? "项目")}`);
          messages.push({ role: "tool", tool_call_id: call.id, content: result });
        } catch (error) {
          const detail = error instanceof Error ? error.message : "工具执行失败";
          events.push(`${call.function.name} · 失败`);
          messages.push({ role: "tool", tool_call_id: call.id, content: `工具错误：${detail}` });
        }
      }
    }

    const files = await listWorkspaceFiles(root);
    return NextResponse.json({ reply, files, previewUrl: `/api/preview?projectId=${encodeURIComponent(projectId)}&v=${Date.now()}`, events, check: lastCheck, mode: "agent", model: process.env.DEEPSEEK_MODEL || "deepseek-flash" });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Agent 执行失败";
    return NextResponse.json({ error: `Agent 执行失败：${detail}` }, { status: 500 });
  }
}
