import { NextResponse } from "next/server";
import { defaultSite, type SiteSpec } from "@/lib/site-model";

function extractJson(content: string) {
  const trimmed = content.trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  return JSON.parse(trimmed);
}

export async function POST(request: Request) {
  const body = (await request.json()) as { message?: unknown; site?: SiteSpec; apiKey?: unknown };
  const message = String(body?.message ?? "").trim();
  const currentSite = (body?.site ?? defaultSite) as SiteSpec;
  const requestApiKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
  const apiKey = requestApiKey || process.env.DEEPSEEK_API_KEY || "";

  if (!message) return NextResponse.json({ error: "请输入修改需求" }, { status: 400 });
  if (!apiKey) {
    return NextResponse.json({ error: "请先在右侧输入 DeepSeek API Key。" }, { status: 503 });
  }

  const system = `你是一个真实的网站建站 Copilot。你负责根据用户的修改要求更新一个可渲染的网站 JSON。

严格规则：
1. 只修改用户明确要求的部分，其他字段原样保留。
2. 返回合法 JSON，不要 Markdown，不要解释 JSON 之外的内容。
3. 返回完整站点对象，不要省略字段。
4. changes 是给用户看的简短中文修改摘要数组。
5. reply 是给用户看的中文回复。
6. 如果请求无法通过当前站点结构完成，保留站点内容，并在 reply 中说明需要扩展组件。

JSON 格式：{"reply": string, "changes": string[], "site": SiteSpec}
SiteSpec 字段：brand、title、subtitle、heroImage、theme(primary/accent/background/surface/text)、sections。
sections 中 kind 只能是 story、menu、stores、quote。`;

  const response = await fetch(`${process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com"}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.DEEPSEEK_MODEL || "deepseek-v4-flash",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: `用户修改要求：\n${message}\n\n当前站点 JSON：\n${JSON.stringify(currentSite)}` },
      ],
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    return NextResponse.json({ error: `DeepSeek 请求失败：${detail.slice(0, 320)}` }, { status: 502 });
  }

  const payload = (await response.json()) as {
    model?: string;
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== "string") return NextResponse.json({ error: "DeepSeek 没有返回有效内容" }, { status: 502 });

  try {
    const result = extractJson(content);
    if (!result?.site || !Array.isArray(result?.changes) || typeof result?.reply !== "string") throw new Error("invalid shape");
    return NextResponse.json({ ...result, mode: "model", model: payload.model || process.env.DEEPSEEK_MODEL || "deepseek-v4-flash" });
  } catch {
    return NextResponse.json({ error: "DeepSeek 返回的内容不是有效的站点 JSON", raw: content.slice(0, 500) }, { status: 502 });
  }
}
