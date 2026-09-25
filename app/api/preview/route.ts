import { NextResponse } from "next/server";
import { ensureWorkspace, listWorkspaceFiles, projectRoot } from "@/lib/project-workspace";

export const runtime = "nodejs";

function errorPage(message: string) {
  const escaped = message.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>预览构建失败</title><style>body{margin:0;padding:48px;font:16px/1.7 system-ui;color:#3d342c;background:#f8f5ef}main{max-width:720px;margin:auto;padding:32px;border:1px solid #e5d9cc;border-radius:20px;background:#fff}h1{font-size:22px}pre{white-space:pre-wrap;color:#8b4935}</style></head><body><main><h1>当前项目暂时无法预览</h1><p>Agent 已经保留代码，你可以在左侧会话中告诉它修复构建问题。</p><pre>${escaped}</pre></main></body></html>`;
}

export async function GET(request: Request) {
  const projectId = new URL(request.url).searchParams.get("projectId") || "coffee-studio";
  try {
    const previewServer = process.env.AI_PREVIEW_SERVER_URL || `http://127.0.0.1:${process.env.AI_PREVIEW_SERVER_PORT || "5174"}`;
    // The preview service owns the persistent project snapshot. The Vinext
    // route filesystem is request-scoped, so reading it here would resurrect
    // the template and silently discard the previous Agent edit.
    const workspace = await fetch(`${previewServer}/workspace?projectId=${encodeURIComponent(projectId)}`, { cache: "no-store" });
    const workspacePayload = workspace.ok ? await workspace.json() as { files?: unknown[] } : { files: [] };
    if (!Array.isArray(workspacePayload.files) || workspacePayload.files.length === 0) {
      const root = projectRoot(projectId);
      await ensureWorkspace(root);
      const sync = await fetch(`${previewServer}/sync`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId, files: await listWorkspaceFiles(root) }), cache: "no-store" });
      if (!sync.ok) throw new Error(`预览工作区初始化失败：${(await sync.text()).slice(0, 300)}`);
    }
    const upstream = await fetch(`${previewServer}/preview?projectId=${encodeURIComponent(projectId)}&v=${Date.now()}`, { cache: "no-store" });
    const html = await upstream.text();
    return new NextResponse(html, { status: upstream.status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "未知构建错误";
    console.error("[preview-route] failed", error);
    return new NextResponse(errorPage(detail), { status: 500, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }
}
