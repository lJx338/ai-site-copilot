import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import os from "node:os";
import path from "node:path";
import { build } from "vite";
import react from "@vitejs/plugin-react";

const port = Number(process.env.AI_PREVIEW_SERVER_PORT || 5174);
// The API route has a request-scoped filesystem, so it uses AI_WORKSPACE_ROOT
// only as a staging area. The preview child owns this durable snapshot root.
const workspaceBase = process.env.AI_PREVIEW_WORKSPACE_ROOT || path.join(process.cwd(), ".ai-site-copilot-workspaces");
// 预览服务只消费 Agent 工作区的快照，不能把同步文件写回 Agent 工作区。
// 两者共用目录会产生反向覆盖：一次较早的 /sync 可能把旧代码写回真实项目，
// 造成 Agent 已报告修改但下一次预览仍是旧版本。
const previewWorkspaceBase = path.join(workspaceBase, ".preview-workspaces");
const runsBase = path.join(workspaceBase, ".runs");
const previewCache = new Map();
const workspaceSignatures = new Map();
const projectQueues = new Map();
const execFileAsync = promisify(execFile);

function enqueue(projectId, task) {
  const previous = projectQueues.get(projectId) || Promise.resolve();
  const current = previous.catch(() => undefined).then(task);
  projectQueues.set(projectId, current);
  return current.finally(() => {
    if (projectQueues.get(projectId) === current) projectQueues.delete(projectId);
  });
}

function projectRoot(projectId) {
  const safeId = String(projectId || "default").replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64) || "default";
  return path.join(previewWorkspaceBase, safeId);
}

async function ensurePreviewDependencies(root) {
  const target = path.join(root, "node_modules");
  const dependencyRoot = path.join(process.cwd(), "node_modules");
  try {
    if (realpathSync(target) === realpathSync(dependencyRoot)) return;
    await rm(target, { recursive: true, force: true });
  } catch { /* link does not exist yet */ }
  await symlink(dependencyRoot, target, "junction").catch(() => undefined);
}

async function collectRelativeFiles(root, directory = root) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".vite") continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectRelativeFiles(root, absolute));
    else files.push(path.relative(root, absolute).replaceAll(path.sep, "/"));
  }
  return files;
}

async function removeStaleFiles(root, keep) {
  for (const relative of await collectRelativeFiles(root)) {
    if (!keep.has(relative)) await rm(path.join(root, relative), { force: true });
  }
}

async function typecheck(root) {
  const tsc = path.join(process.cwd(), "node_modules/typescript/bin/tsc");
  try {
    await execFileAsync(process.execPath, [tsc, "--noEmit", "-p", path.join(root, "tsconfig.json")], {
      cwd: root,
      maxBuffer: 2 * 1024 * 1024,
    });
  } catch (error) {
    // execFile 的 message 只有 "Command failed"，会把真正的 TypeScript
    // 诊断吞掉，Agent 也就无法根据错误自动修复。把 stderr/stdout 原样
    // 传回 /validate 和预览错误页，形成可闭环的修复证据。
    const stdout = typeof error?.stdout === "string" ? error.stdout.trim() : "";
    const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
    const message = error instanceof Error ? error.message : "TypeScript 检查失败";
    const detail = [stderr, stdout].filter(Boolean).join("\n") || message;
    throw new Error(`TypeScript 检查失败：\n${detail}`);
  }
}

function assetName(url) {
  return url.split("?")[0].split("/").filter(Boolean).at(-1) || url;
}

function findAsset(assets, url) {
  const normalized = url.replace(/^\/+/, "");
  return assets.get(normalized) || assets.get(`assets/${assetName(url)}`);
}

async function buildPreview(root) {
  const dependencyRoot = process.cwd();
  await ensurePreviewDependencies(root);
  await typecheck(root);
  const reactRoot = path.join(dependencyRoot, "node_modules/react");
  const reactDomRoot = path.join(dependencyRoot, "node_modules/react-dom");
  const result = await build({
    root,
    configFile: false,
    clearScreen: false,
    plugins: [react()],
    resolve: {
      alias: [
        // 保留 react-dom/client 和 react/jsx-runtime 的子路径。之前的
        // 宽正则会把 react-dom/client 错映射到 react-dom/index，导致
        // 构建通过但浏览器运行时找不到 createRoot。
        { find: /^react-dom\/(.+)$/, replacement: `${reactDomRoot}/$1` },
        { find: "react-dom", replacement: reactDomRoot },
        { find: /^react\/(.+)$/, replacement: `${reactRoot}/$1` },
        { find: "react", replacement: reactRoot },
        { find: /^lucide-react(?:\/.*)?$/, replacement: path.join(dependencyRoot, "node_modules/lucide-react") },
      ],
    },
    build: { write: false, emptyOutDir: false, assetsInlineLimit: Number.MAX_SAFE_INTEGER },
  });
  const output = (Array.isArray(result) ? result[0] : result).output;
  const htmlAsset = output.find((item) => item.type === "asset" && item.fileName.endsWith(".html"));
  if (!htmlAsset || typeof htmlAsset.source !== "string") throw new Error("Vite 没有生成 index.html");
  const byName = new Map(output.map((item) => [item.fileName, item]));
  let html = htmlAsset.source;
  html = html.replace(/<script([^>]+)src=["']([^"']+)["']([^>]*)><\/script>/g, (match, before, src, after) => {
    const chunk = findAsset(byName, src);
    return chunk?.type === "chunk" && chunk.code ? `<script${before}${after}>${chunk.code}</script>` : match;
  });
  html = html.replace(/<link([^>]+)href=["']([^"']+\.css)["']([^>]*)>/g, (match, before, href, after) => {
    const css = findAsset(byName, href);
    const source = css?.type === "asset" && typeof css.source === "string" ? css.source : "";
    return source ? `<style${before}${after}>${source}</style>` : match;
  });
  return html;
}

function filesSignature(files) {
  const hash = createHash("sha256");
  for (const file of files.sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.content);
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function buildPreviewCached(projectId, root) {
  const signature = workspaceSignatures.get(projectId) || "";
  const cached = previewCache.get(projectId);
  if (cached && cached.signature === signature) return { html: cached.html, cached: true };
  const html = await buildPreview(root);
  previewCache.set(projectId, { signature, html });
  return { html, cached: false };
}

// ---- 运行时检查：用无头 Chrome 逐个打开路由 ----
// 静态检查只能看源码，这里真正渲染每个页面，发现白屏、运行时报错、
// “未注册路由回退到首页/404” 和死链。找不到浏览器时跳过，不阻塞建站。
function findChrome() {
  // Playwright 的 headless shell 启动最快（单页约 4 秒）；完整版 Chrome 会做
  // 更新检查、同步注册等后台工作，放在后面兜底。
  const candidates = [process.env.CHROME_PATH];
  for (const cache of [path.join(os.homedir(), "Library/Caches/ms-playwright"), path.join(os.homedir(), ".cache/ms-playwright"), path.join(process.env.LOCALAPPDATA || "", "ms-playwright")]) {
    try {
      for (const build of readdirSync(cache).filter((name) => name.startsWith("chromium")).sort((a, b) => Number(b.startsWith("chromium_headless_shell")) - Number(a.startsWith("chromium_headless_shell")) || b.localeCompare(a))) {
        for (const platform of readdirSync(path.join(cache, build))) {
          for (const binary of ["chrome-headless-shell", "chrome-headless-shell.exe", "chrome", "chrome.exe", "Chromium.app/Contents/MacOS/Chromium", "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"]) candidates.push(path.join(cache, build, platform, binary));
        }
      }
    } catch { /* no playwright cache */ }
  }
  candidates.push(
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  );
  return candidates.find((candidate) => candidate && existsSync(candidate)) || null;
}

const inspectProbe = `<script>(function(){var list=[];function push(m){list.push(String(m).slice(0,300));document.documentElement.setAttribute("data-inspect-errors",JSON.stringify(list));}addEventListener("error",function(e){push(e.message||e.error)});addEventListener("unhandledrejection",function(e){push(e.reason&&e.reason.message||e.reason)});var ce=console.error;console.error=function(){push(Array.prototype.join.call(arguments," "));ce.apply(console,arguments)};})();</script>`;

function decodeEntities(value) {
  return value.replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

function normalizeRoute(route) {
  const trimmed = String(route).trim().replace(/^#/, "").split(/[?#]/)[0].replace(/\/+$/, "");
  return !trimmed || trimmed === "/" ? "/" : trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function analyzeDom(dom) {
  const errorsAttr = dom.match(/data-inspect-errors="([^"]*)"/);
  let errors = [];
  try { errors = errorsAttr ? JSON.parse(decodeEntities(errorsAttr[1])) : []; } catch { errors = []; }
  const root = (dom.match(/<div id="root"[\s\S]*<\/body>/i) || [dom])[0];
  const withoutChrome = root.replace(/<(script|style|template)[\s\S]*?<\/\1>/gi, " ").replace(/<header[\s\S]*?<\/header>/gi, " ").replace(/<footer[\s\S]*?<\/footer>/gi, " ");
  const text = decodeEntities(withoutChrome.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
  const links = [...root.matchAll(/href="#(\/[^"]*)"/g)].map((match) => normalizeRoute(match[1]));
  return { errors, text, links };
}

async function dumpDom(chrome, url) {
  const profile = await mkdtemp(path.join(os.tmpdir(), "ai-site-inspect-profile-"));
  const args = ["--headless", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--no-service-autorun", "--password-store=basic", "--use-mock-keychain", "--disable-features=Translate,MediaRouter,OptimizationHints", "--hide-scrollbars", `--user-data-dir=${profile}`, "--window-size=1280,900", "--virtual-time-budget=3000", "--dump-dom", url];
  if (typeof process.getuid === "function" && process.getuid() === 0) args.unshift("--no-sandbox");
  try {
    const { stdout } = await execFileAsync(chrome, args, { timeout: 30000, killSignal: "SIGKILL", maxBuffer: 32 * 1024 * 1024 });
    return stdout;
  } finally {
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function mapLimit(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await task(items[index], index); }
  }));
  return results;
}

async function inspectSite(projectId, html, manifest) {
  const chrome = findChrome();
  if (!chrome) return { ok: true, skipped: true, issues: [], reason: "未找到 Chrome/Chromium，跳过运行时检查（可以设置 CHROME_PATH）" };
  const routes = [...new Set([...manifest.matchAll(/path:\s*["'`]([^"'`]+)["'`]/g)].map((match) => normalizeRoute(match[1])))].filter((route) => route !== "/404");
  if (!routes.includes("/")) routes.unshift("/");
  const file = path.join(os.tmpdir(), `ai-site-inspect-${String(projectId).replace(/[^a-zA-Z0-9_-]/g, "-")}.html`);
  await writeFile(file, html.includes("<head>") ? html.replace("<head>", `<head>${inspectProbe}`) : `${inspectProbe}${html}`, "utf8");
  const notFoundRoute = "/__inspect_not_found__";
  const pages = await mapLimit([...routes, notFoundRoute], 3, async (route) => {
    try { return { route, ...analyzeDom(await dumpDom(chrome, `${pathToFileURL(file).href}#${route}`)) }; }
    catch (error) { return { route, failed: error instanceof Error ? error.message.slice(0, 200) : "浏览器检查失败", errors: [], text: "", links: [] }; }
  });
  const byRoute = new Map(pages.map((page) => [page.route, page]));
  const home = byRoute.get("/");
  const notFound = byRoute.get(notFoundRoute);
  const known = new Set(routes);
  const issues = [];
  for (const page of pages) {
    if (page.route === notFoundRoute || page.failed) continue;
    if (page.errors.length) issues.push(`路由 ${page.route} 运行时报错：${page.errors.slice(0, 3).join(" | ")}`);
    if (page.text.length < 60) issues.push(`路由 ${page.route} 页面主体几乎为空（除导航和页脚外只有 ${page.text.length} 个字符），可能白屏或组件没有渲染内容`);
    else if (page.route !== "/" && home && !home.failed && page.text === home.text) issues.push(`路由 ${page.route} 显示的是首页内容：App.tsx 没有为它渲染独立页面`);
    else if (page.route !== "/" && notFound && !notFound.failed && page.text === notFound.text) issues.push(`路由 ${page.route} 显示的是 404 页面：App.tsx 没有注册它`);
    const dead = [...new Set(page.links.filter((link) => !known.has(link)))];
    if (dead.length) issues.push(`路由 ${page.route} 页面上有指向未注册路由的链接：${dead.join("、")}`);
  }
  const failed = pages.filter((page) => page.failed);
  return {
    ok: issues.length === 0,
    skipped: failed.length === pages.length,
    issues,
    routes: pages.filter((page) => page.route !== notFoundRoute).map((page) => ({ route: page.route, chars: page.text.length, errors: page.errors.length, failed: page.failed })),
  };
}

// ---- 运行归档：成品快照、单文件 HTML、逐页渲染数据和整页截图 ----
// 用 DevTools 协议截整页：保持真实视口高度（100vh 不变形），先滚动一遍触发
// 懒加载和进入视口动画，再用 captureBeyondViewport 截出完整页面。
async function withCdp(chrome, task) {
  const profile = await mkdtemp(path.join(os.tmpdir(), "ai-site-cdp-"));
  const args = ["--headless", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--password-store=basic", "--use-mock-keychain", "--hide-scrollbars", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank"];
  if (typeof process.getuid === "function" && process.getuid() === 0) args.unshift("--no-sandbox");
  const child = spawn(chrome, args, { stdio: "ignore" });
  try {
    let endpoint = "";
    for (let i = 0; i < 100 && !endpoint; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      try { const [port, wsPath] = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).trim().split("\n"); endpoint = `ws://127.0.0.1:${port}${wsPath}`; } catch { /* not ready yet */ }
    }
    if (!endpoint) throw new Error("无头浏览器没有启动");
    const socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
    let nextId = 0;
    const pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
      }
    });
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    try { return await task(send); } finally { socket.close(); }
  } finally {
    child.kill("SIGKILL");
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function captureFullPage(send, url, width, height, mobile, file) {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  try {
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile }, sessionId);
    await send("Page.navigate", { url }, sessionId);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await send("Runtime.evaluate", { awaitPromise: true, expression: `(async () => { const wait = (ms) => new Promise((r) => setTimeout(r, ms)); for (let y = 0; y < document.documentElement.scrollHeight; y += innerHeight * 0.8) { scrollTo(0, y); await wait(120); } scrollTo(0, 0); await wait(600); })()` }, sessionId);
    const metrics = await send("Page.getLayoutMetrics", {}, sessionId);
    const size = metrics.cssContentSize || metrics.contentSize;
    const fullHeight = Math.min(Math.ceil(size.height), 16000);
    const { data } = await send("Page.captureScreenshot", { format: "jpeg", quality: 72, captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: fullHeight, scale: 1 } }, sessionId);
    await writeFile(file, Buffer.from(data, "base64"));
    return fullHeight;
  } finally {
    await send("Target.closeTarget", { targetId }).catch(() => undefined);
  }
}

async function archiveRun(runDir, projectId) {
  const root = projectRoot(projectId);
  const siteDir = path.join(runDir, "site");
  await rm(siteDir, { recursive: true, force: true });
  await mkdir(siteDir, { recursive: true });
  for (const entry of ["src", "docs", "design", "index.html"]) {
    await cp(path.join(root, entry), path.join(siteDir, entry), { recursive: true }).catch(() => undefined);
  }
  const html = await enqueue(projectId, () => buildPreviewCached(projectId, realpathSync(root))).then((result) => result.html).catch(() => "");
  if (!html) return { archived: true, screenshots: 0, reason: "构建失败，未生成截图" };
  await writeFile(path.join(runDir, "site.html"), html, "utf8");
  const chrome = findChrome();
  if (!chrome) return { archived: true, screenshots: 0, reason: "未找到浏览器" };
  const manifest = await readFile(path.join(root, "src/app/site-manifest.ts"), "utf8").catch(() => "");
  const routes = [...new Set([...manifest.matchAll(/path:\s*["'`]([^"'`]+)["'`]/g)].map((match) => normalizeRoute(match[1])))].filter((route) => route !== "/404");
  if (!routes.includes("/")) routes.unshift("/");
  const screensDir = path.join(runDir, "screens");
  await mkdir(screensDir, { recursive: true });
  const htmlUrl = pathToFileURL(path.join(runDir, "site.html")).href;
  const render = {};
  let screenshots = 0;
  await withCdp(chrome, async (send) => {
    for (const route of routes) {
      const name = route === "/" ? "home" : route.replace(/^\//, "").replace(/[^a-zA-Z0-9-]+/g, "_");
      render[route] = {};
      for (const [label, width, height, mobile] of [["desktop", 1440, 900, false], ["mobile", 390, 844, true]]) {
        try {
          render[route][label] = await captureFullPage(send, `${htmlUrl}#${route}`, width, height, mobile, path.join(screensDir, `${name}-${label}.jpg`));
          screenshots += 1;
        } catch (error) {
          render[route][label] = `失败：${error instanceof Error ? error.message : String(error)}`;
        }
      }
    }
  });
  // 渲染后的正文字数（去掉导航和页脚），与运行时检查同一套口径
  const inspection = await inspectSite(projectId, html, manifest).catch(() => null);
  for (const item of inspection?.routes ?? []) render[item.route] = { ...(render[item.route] ?? {}), chars: item.chars, errors: item.errors };
  await writeFile(path.join(runDir, "render.json"), JSON.stringify(render, null, 2), "utf8");
  return { archived: true, screenshots };
}

function errorPage(message) {
  const escaped = message.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>预览构建失败</title><style>body{margin:0;padding:48px;font:16px/1.7 system-ui;color:#3d342c;background:#f8f5ef}main{max-width:720px;margin:auto;padding:32px;border:1px solid #e5d9cc;border-radius:20px;background:#fff}h1{font-size:22px}pre{white-space:pre-wrap;color:#8b4935}</style></head><body><main><h1>当前项目暂时无法预览</h1><p>系统已把完整的 TypeScript 或构建诊断交给 Agent；修复成功后会自动重新展示。</p><pre>${escaped}</pre></main></body></html>`;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
  if (url.pathname === "/sync" && request.method === "POST") {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const projectId = String(payload.projectId || "coffee-studio");
      const root = projectRoot(projectId);
      const files = Array.isArray(payload.files) ? payload.files.map((file) => ({ path: String(file.path || "").replaceAll("\\", "/"), content: String(file.content || "") })) : [];
      await enqueue(projectId, async () => {
        await mkdir(root, { recursive: true });
        const accepted = files.filter((file) => file.path && !file.path.includes("..") && !file.path.startsWith("/") && !file.path.startsWith("node_modules/") && !file.path.includes(".preview-dist/"));
        const keep = new Set(accepted.map((file) => file.path));
        for (const file of accepted) {
          const target = path.resolve(root, file.path);
          if (!target.startsWith(`${path.resolve(root)}${path.sep}`)) continue;
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, file.content, "utf8");
        }
        // Treat /sync as a snapshot. This prevents deleted or renamed files
        // from surviving in the preview and changing later builds.
        await removeStaleFiles(root, keep);
        await ensurePreviewDependencies(root);
        workspaceSignatures.set(projectId, filesSignature(accepted));
      });
      response.writeHead(204); response.end();
    } catch (error) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end(error instanceof Error ? error.message : "同步失败");
    }
    return;
  }
  if (url.pathname === "/workspace" && request.method === "GET") {
    const projectId = url.searchParams.get("projectId") || "coffee-studio";
    try {
      const root = projectRoot(projectId);
      const files = await enqueue(projectId, async () => {
        try { await readdir(root); } catch { return []; }
        const result = [];
        for (const relative of await collectRelativeFiles(root)) {
          result.push({ path: relative, content: await readFile(path.join(root, relative), "utf8") });
        }
        return result;
      });
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify({ projectId, files }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : "读取工作区失败" }));
    }
    return;
  }
  if (url.pathname === "/runs" && request.method === "POST") {
    // 保存一次建站的运行报告和每个 Agent 的完整对话，用来分析成本和修复过程。
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const runId = String(payload.runId || Date.now()).replace(/[^a-zA-Z0-9_-]/g, "-");
      const runDir = path.join(runsBase, runId);
      await mkdir(path.join(runDir, "transcripts"), { recursive: true });
      await writeFile(path.join(runDir, "report.json"), JSON.stringify(payload.report, null, 2), "utf8");
      await writeFile(path.join(runDir, "summary.txt"), String(payload.table || ""), "utf8");
      for (const [agent, messages] of Object.entries(payload.transcripts || {})) {
        await writeFile(path.join(runDir, "transcripts", `${agent.replace(/[\\/:*?"<>|\s]/g, "_")}.json`), JSON.stringify(messages, null, 2), "utf8");
      }
      await writeFile(path.join(runsBase, "latest.txt"), runId, "utf8");
      // 先把成品源码复制下来（很快），截图在后台完成，不拖慢用户看到结果。
      const projectId = String(payload.projectId || "");
      if (projectId) {
        archiveRun(runDir, projectId)
          .then((result) => console.log(`[run] ${runId} 已归档：${result.screenshots} 张截图${result.reason ? `（${result.reason}）` : ""}`))
          .catch((error) => console.warn(`[run] ${runId} 归档失败：${error instanceof Error ? error.message : error}`));
      }
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: true, dir: runDir }));
    } catch (error) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end(error instanceof Error ? error.message : "保存运行报告失败");
    }
    return;
  }
  if (url.pathname === "/runs/archive" && request.method === "POST") {
    // 手动归档某个项目的当前状态到指定运行目录（用于补齐基线数据）。
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const runDir = path.join(runsBase, String(payload.runId || "").replace(/[^a-zA-Z0-9_-]/g, "-"));
      const result = await archiveRun(runDir, String(payload.projectId || "coffee-studio"));
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end(error instanceof Error ? error.message : "归档失败");
    }
    return;
  }
  if (url.pathname === "/typecheck") {
    // 页面 Agent 写完自己的文件后立即做类型检查，不必等整站构建。
    const projectId = url.searchParams.get("projectId") || "coffee-studio";
    const result = await enqueue(projectId, async () => {
      const root = realpathSync(projectRoot(projectId));
      await ensurePreviewDependencies(root);
      try { await typecheck(root); return { ok: true, output: "" }; }
      catch (error) { return { ok: false, output: error instanceof Error ? error.message : "TypeScript 检查失败" }; }
    }).catch((error) => ({ ok: false, output: error instanceof Error ? error.message : "TypeScript 检查失败" }));
    response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    response.end(JSON.stringify(result));
    return;
  }
  if (url.pathname === "/inspect") {
    const projectId = url.searchParams.get("projectId") || "coffee-studio";
    try {
      const result = await enqueue(projectId, async () => {
        const root = realpathSync(projectRoot(projectId));
        const { html } = await buildPreviewCached(projectId, root);
        const manifest = await readFile(path.join(root, "src/app/site-manifest.ts"), "utf8").catch(() => "");
        return inspectSite(projectId, html, manifest);
      });
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify({ ok: true, skipped: true, issues: [], reason: error instanceof Error ? error.message : "运行时检查失败" }));
    }
    return;
  }
  if (url.pathname === "/validate") {
    const projectId = url.searchParams.get("projectId") || "coffee-studio";
    try {
      const root = realpathSync(projectRoot(projectId));
      const result = await enqueue(projectId, () => buildPreviewCached(projectId, root));
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify({ ok: true, cached: result.cached }));
    } catch (error) {
      const detail = error instanceof Error ? error.message : "未知构建错误";
      response.writeHead(500, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify({ ok: false, error: detail }));
    }
    return;
  }
  if (url.pathname !== "/preview") { response.writeHead(404); response.end("Not found"); return; }
  try {
    const projectId = url.searchParams.get("projectId") || "coffee-studio";
    const { html } = await enqueue(projectId, () => buildPreviewCached(projectId, realpathSync(projectRoot(projectId))));
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(html);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "未知构建错误";
    response.writeHead(500, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(errorPage(detail));
  }
});

server.listen(port, "127.0.0.1", () => console.log(`[preview] local Vite builder listening on http://127.0.0.1:${port}`));
