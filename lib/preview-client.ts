import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { listWorkspaceFiles, removeFilesNotIn, safeWorkspacePath } from "./project-workspace";

export type ValidationResult = { ok: boolean; cached?: boolean; error?: string; skipped?: boolean };
export type InspectResult = { ok: boolean; skipped?: boolean; reason?: string; issues: string[]; routes?: Array<{ route: string; chars: number; errors: number; failed?: string }> };

export function previewServerUrl() {
  return process.env.AI_PREVIEW_SERVER_URL || `http://127.0.0.1:${process.env.AI_PREVIEW_SERVER_PORT || "5174"}`;
}

export async function restoreWorkspaceFromPreview(projectId: string, root: string) {
  const response = await fetch(`${previewServerUrl()}/workspace?projectId=${encodeURIComponent(projectId)}`, { cache: "no-store" });
  if (!response.ok) return false;
  const payload = await response.json() as { files?: Array<{ path?: string; content?: string }> };
  const files = Array.isArray(payload.files) ? payload.files : [];
  // 预览快照是项目的权威版本：临时工作区里多出来的文件（旧页面、模板残留）要删掉。
  if (files.length) await removeFilesNotIn(root, new Set(files.map((file) => String(file.path || ""))));
  for (const file of files) {
    const relativePath = String(file.path || "");
    if (!relativePath) continue;
    const target = safeWorkspacePath(root, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, String(file.content || ""), "utf8");
  }
  return files.length > 0;
}

export async function syncWorkspaceToPreview(projectId: string, root: string) {
  const snapshot = await listWorkspaceFiles(root);
  const response = await fetch(`${previewServerUrl()}/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId, files: snapshot }),
  });
  if (!response.ok) throw new Error(`预览同步失败（HTTP ${response.status}）`);
}

export async function validatePreview(projectId: string): Promise<ValidationResult> {
  const response = await fetch(`${previewServerUrl()}/validate?projectId=${encodeURIComponent(projectId)}`);
  const raw = await response.text();
  let payload: ValidationResult = { ok: response.ok };
  try { payload = { ...payload, ...(JSON.parse(raw) as ValidationResult) }; } catch { /* use HTTP status */ }
  if (!response.ok) return { ...payload, ok: false, error: payload.error || raw.slice(0, 500) || `预览校验失败（HTTP ${response.status}）` };
  return payload;
}

// 同步当前工作区并只运行 TypeScript 检查。返回 null 表示预览服务不可用。
export async function typecheckWorkspace(projectId: string, root: string): Promise<{ ok: boolean; output: string } | null> {
  try {
    await syncWorkspaceToPreview(projectId, root);
    const response = await fetch(`${previewServerUrl()}/typecheck?projectId=${encodeURIComponent(projectId)}`);
    if (!response.ok) return null;
    return await response.json() as { ok: boolean; output: string };
  } catch {
    return null;
  }
}

// 用无头浏览器逐个打开路由。调用前需要已经同步并构建成功。
export async function inspectPreview(projectId: string): Promise<InspectResult> {
  try {
    const response = await fetch(`${previewServerUrl()}/inspect?projectId=${encodeURIComponent(projectId)}`);
    if (!response.ok) return { ok: true, skipped: true, issues: [], reason: `HTTP ${response.status}` };
    const payload = await response.json() as InspectResult;
    return { ...payload, issues: Array.isArray(payload.issues) ? payload.issues : [] };
  } catch (error) {
    return { ok: true, skipped: true, issues: [], reason: error instanceof Error ? error.message : "运行时检查不可用" };
  }
}

// tsc 输出里只保留属于指定文件的诊断，避免页面 Agent 被其他并行页面的错误干扰。
export function diagnosticsFor(output: string, files: string[]) {
  return output.split(/\r?\n/).filter((line) => files.some((file) => line.startsWith(file) || line.includes(`/${file}(`))).slice(0, 20);
}

// 运行报告写在预览服务那边（API 运行时不能写项目目录）。失败只打日志，不影响建站。
export async function saveRunReport(payload: { runId: string; projectId: string; report: unknown; table: string; transcripts: Record<string, unknown> }) {
  try {
    const response = await fetch(`${previewServerUrl()}/runs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (!response.ok) throw new Error(`HTTP ${response.status}：${(await response.text()).slice(0, 200)}`);
    return (await response.json() as { dir?: string }).dir ?? null;
  } catch (error) {
    console.warn(`[run] 保存运行报告失败：${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export type LintItem = { type: string; msg: string; count: number; samples: string[] };
export type PageScreens = { route: string; viewport: "desktop" | "mobile"; fullHeight?: number; tiles: string[]; lint: { must: LintItem[]; should: LintItem[]; metrics: Record<string, number> }; error?: string };

// 逐页视觉检查 + 截图切片（base64 JPEG）。预览服务不可用时返回 skipped。
export async function fetchScreens(projectId: string, maxTiles = 6): Promise<{ skipped: boolean; reason?: string; pages: PageScreens[] }> {
  try {
    const response = await fetch(`${previewServerUrl()}/screens?projectId=${encodeURIComponent(projectId)}&maxTiles=${maxTiles}`);
    if (!response.ok) return { skipped: true, reason: `HTTP ${response.status}`, pages: [] };
    return await response.json() as { skipped: boolean; reason?: string; pages: PageScreens[] };
  } catch (error) {
    return { skipped: true, reason: error instanceof Error ? error.message : "视觉检查不可用", pages: [] };
  }
}
