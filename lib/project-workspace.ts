import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { templateFiles } from "./project-template";

export type WorkspaceFile = { path: string; content: string };
export type WorkspaceFileSummary = { path: string; bytes: number };

const ignoredDirectories = new Set(["node_modules", ".git", "dist", ".vite"]);
const allowedExtensions = new Set([".ts", ".tsx", ".css", ".json", ".md", ".html"]);
const allowedRootFiles = new Set(["package.json", "tsconfig.json", "vite.config.ts", "index.html", "AGENT.md", "README.md"]);

export function projectRoot(projectId: string) {
  const safeId = projectId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64) || "default";
  // `scripts/run-framework.mjs` sets this explicitly for both the Vinext API
  // process and the preview child. Keep the /tmp fallback for direct tests;
  // Vinext does not permit writes under the application checkout.
  const base = process.env.AI_WORKSPACE_ROOT || "/tmp/ai-site-copilot-workspaces";
  return path.join(base, safeId);
}

function normalizeRelative(relativePath: string) {
  return relativePath.replaceAll("\\", "/").replace(/^\/+/, "");
}

export function safeWorkspacePath(root: string, relativePath: string) {
  const normalized = normalizeRelative(relativePath);
  const segments = normalized.split("/");
  if (!normalized || normalized.startsWith("../") || segments.includes("..") || segments.some((segment) => ignoredDirectories.has(segment))) throw new Error("非法文件路径");
  const fileName = segments.at(-1) ?? "";
  const extension = path.extname(fileName);
  if (!allowedRootFiles.has(normalized) && !allowedExtensions.has(extension)) throw new Error("这个文件类型不在 Agent 工作区白名单内");
  const target = path.resolve(root, normalized);
  if (!target.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error("非法文件路径");
  return target;
}

// 只在工作区还没有初始化时写入模板。已初始化的项目里被删除的模板文件
// （例如新网站不需要的页面）不能被自动补回来，否则会变成孤儿页面和死链。
export async function ensureWorkspace(root: string) {
  await mkdir(root, { recursive: true });
  try { await stat(path.join(root, "src/main.tsx")); return; } catch { /* not initialized yet */ }
  for (const [relative, content] of Object.entries(templateFiles)) {
    const target = path.join(root, relative);
    try { await stat(target); } catch { await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, content, "utf8"); }
  }
}

// Skills 和 AGENT.md 是系统规则，不是项目内容。旧项目的快照里可能保存着
// 旧版规则（例如“没有事实时使用占位符”），每次请求都用模板版本覆盖。
const systemFiles = Object.keys(templateFiles).filter((relative) => relative === "AGENT.md" || relative.startsWith("skills/"));

export async function refreshSystemFiles(root: string) {
  for (const relative of systemFiles) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, templateFiles[relative as keyof typeof templateFiles], "utf8");
  }
}

export const STUB_MARKER = "@ai-stub";

export type ScaffoldPage = { name: string; route: string; goal: string };

export function normalizeRoute(route: string) {
  const trimmed = route.trim().replace(/^#/, "").split(/[?#]/)[0].replace(/\/+$/, "");
  if (!trimmed || trimmed === "/") return "/";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function pageComponentName(route: string, index = 0) {
  if (route === "/") return "HomePage";
  const words = route.split(/[/_-]+/).filter(Boolean);
  if (!words.length || words.some((word) => !/^[a-zA-Z0-9]+$/.test(word)) || /^[0-9]/.test(words[0])) return `Page${index + 1}`;
  return `${words.map((word) => word[0].toUpperCase() + word.slice(1).toLowerCase()).join("")}Page`;
}

export function pageSlug(route: string, index = 0) {
  if (route === "/") return "home";
  const slug = route.replace(/^\/+/, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
  return slug || `page-${index + 1}`;
}

export type PlannedPage = ScaffoldPage & { component: string; file: string; slug: string };

export function planPages(pages: ScaffoldPage[]): PlannedPage[] {
  const seen = new Set<string>();
  const result: PlannedPage[] = [];
  pages.forEach((page, index) => {
    const route = normalizeRoute(page.route);
    if (seen.has(route) || route === "/404" || route.includes("*") || route.includes(":")) return;
    seen.add(route);
    let component = pageComponentName(route, index);
    if (component === "NotFoundPage" || result.some((item) => item.component === component)) component = `${component.replace(/Page$/, "")}${index + 1}Page`;
    result.push({ name: page.name, goal: page.goal, route, component, file: `src/pages/${component}.tsx`, slug: pageSlug(route, index) });
  });
  if (!seen.has("/")) result.unshift({ name: "首页", goal: "介绍品牌、展示核心内容并引导转化", route: "/", component: "HomePage", file: "src/pages/HomePage.tsx", slug: "home" });
  return result;
}

function jsString(value: string) {
  return JSON.stringify(value);
}

// 新建网站时由代码而不是模型生成路由骨架：每个计划页面都有文件、
// 都在 App.tsx 注册、都在 manifest 中出现。模型只负责填充内容，
// 不会再出现“导航里有但路由没接”的死链。
export async function scaffoldSite(root: string, brand: string, pages: ScaffoldPage[]) {
  const planned = planPages(pages);
  for (const directory of ["src", "design"]) await rm(path.join(root, directory), { recursive: true, force: true });
  for (const [relative, content] of Object.entries(templateFiles)) {
    if (!relative.startsWith("src/") && !relative.startsWith("design/")) continue;
    if (relative.startsWith("src/pages/") && relative !== "src/pages/NotFoundPage.tsx") continue;
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  const manifest = `export const siteManifest = {\n  brand: ${jsString(brand || "品牌名称")},\n  routes: [\n${planned.map((page) => `    { path: ${jsString(page.route)}, label: ${jsString(page.name)} },`).join("\n")}\n  ],\n} as const;\n`;
  await writeFile(path.join(root, "src/app/site-manifest.ts"), manifest, "utf8");
  const imports = planned.map((page) => `import ${page.component} from "../pages/${page.component}";`).join("\n");
  const routeMap = planned.map((page) => `  ${jsString(page.route)}: ${page.component},`).join("\n");
  const app = `import type { ComponentType } from "react";\nimport SiteLayout from "../layouts/SiteLayout";\nimport { useRouter } from "./router";\n${imports}\nimport NotFoundPage from "../pages/NotFoundPage";\n\n// 每个路由都必须在这里注册；未注册的地址显示 404，而不是悄悄回到首页。\nconst routes: Record<string, ComponentType> = {\n${routeMap}\n};\n\nexport default function App() {\n  const { path } = useRouter();\n  const Page = routes[path] ?? NotFoundPage;\n  return <SiteLayout><Page /></SiteLayout>;\n}\n`;
  await writeFile(path.join(root, "src/app/App.tsx"), app, "utf8");
  for (const page of planned) {
    const stub = `// ${STUB_MARKER} 页面骨架，等待页面 Agent 实现。\nimport PageHero from "../components/site/PageHero";\n\nexport default function ${page.component}() {\n  return <PageHero eyebrow=${jsString(page.slug.toUpperCase())} title=${jsString(page.name)} description=${jsString(page.goal)} />;\n}\n`;
    await writeFile(path.join(root, page.file), stub, "utf8");
  }
  return planned;
}

async function collectFiles(root: string, directory = root): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (ignoredDirectories.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(root, absolute));
    else {
      const relative = path.relative(root, absolute).replaceAll(path.sep, "/");
      try { safeWorkspacePath(root, relative); files.push(relative); } catch { /* hidden from the Agent */ }
    }
  }
  return files.sort();
}

export async function removeFilesNotIn(root: string, keep: Set<string>) {
  for (const relative of await collectFiles(root)) if (!keep.has(relative)) await rm(path.join(root, relative), { force: true });
}

export async function listWorkspaceFiles(root: string): Promise<WorkspaceFile[]> {
  await ensureWorkspace(root);
  const files: WorkspaceFile[] = [];
  for (const relative of await collectFiles(root)) {
    try { files.push({ path: relative, content: await readFile(path.join(root, relative), "utf8") }); } catch { /* skip unreadable files */ }
  }
  return files;
}

export async function listWorkspaceSummaries(root: string): Promise<WorkspaceFileSummary[]> {
  await ensureWorkspace(root);
  const summaries: WorkspaceFileSummary[] = [];
  for (const relative of await collectFiles(root)) {
    try { summaries.push({ path: relative, bytes: (await stat(path.join(root, relative))).size }); } catch { /* skip missing files */ }
  }
  return summaries;
}

export async function searchWorkspace(root: string, query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const matches: Array<{ path: string; line: number; text: string }> = [];
  for (const file of await listWorkspaceFiles(root)) {
    const lines = file.content.split(/\r?\n/);
    lines.forEach((line, index) => { if (line.toLowerCase().includes(needle)) matches.push({ path: file.path, line: index + 1, text: line.trim().slice(0, 240) }); });
  }
  return matches.slice(0, 80);
}

export async function applyWorkspacePatch(root: string, relativePath: string, find: string, replace: string) {
  const target = safeWorkspacePath(root, relativePath);
  const content = await readFile(target, "utf8");
  if (!find) throw new Error("补丁匹配内容不能为空");
  const occurrences = content.split(find).length - 1;
  if (occurrences === 0) throw new Error(`在 ${relativePath} 中没有找到匹配内容`);
  if (occurrences > 1) throw new Error(`补丁在 ${relativePath} 中匹配了 ${occurrences} 处，请提供更具体的上下文`);
  await writeFile(target, content.replace(find, replace), "utf8");
  return { path: relativePath, occurrences: 1 };
}

export type ProjectIssue = { file: string; message: string; severity: "error" | "warning" };

function stripComments(source: string) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

const placeholderPatterns: Array<[RegExp, string]> = [
  [/\{[^{}\n]{0,40}(占位|待定|待确认|待补充)[^{}\n]{0,40}\}/, "占位符"],
  [/占位|待确认|待补充|敬请期待|等待真实内容|一段简洁的/, "占位文案"],
  [/lorem ipsum/i, "lorem ipsum"],
  [/example\.(com|org|net)/i, "示例域名"],
  [/\b[xX]{3,}\b|\*{4,}/, "打码/占位数字"],
  [/\bTODO\b|\bTBD\b/, "TODO 标记"],
];

function snippetAround(source: string, index: number) {
  return source.slice(Math.max(0, index - 12), index + 28).replace(/\s+/g, " ").trim();
}

// 模板页面里的长中文文案。新网站如果仍然出现这些句子，说明页面没有被真正改写。
const templatePagePhrases = (() => {
  const phrases = new Set<string>();
  for (const [relative, content] of Object.entries(templateFiles)) {
    if (!/^src\/(pages\/(?!NotFoundPage)|components\/site\/Footer)/.test(relative)) continue;
    for (const match of content.matchAll(/[一-鿿][^"'`<>{}\n]{5,}/g)) {
      const phrase = match[0].trim();
      if ((phrase.match(/[一-鿿]/g) ?? []).length >= 6) phrases.add(phrase);
    }
  }
  return [...phrases];
})();

export function manifestRoutes(files: WorkspaceFile[]) {
  const manifest = files.find((file) => file.path === "src/app/site-manifest.ts")?.content ?? "";
  return [...new Set([...manifest.matchAll(/path:\s*["'`]([^"'`]+)["'`]/g)].map((match) => normalizeRoute(match[1])))];
}

function localImports(file: WorkspaceFile) {
  const directory = path.posix.dirname(file.path);
  const result: string[] = [];
  for (const match of file.content.matchAll(/(?:from|import)\s+["'](\.{1,2}\/[^"']+)["']/g)) {
    result.push(path.posix.normalize(path.posix.join(directory, match[1])));
  }
  return result;
}

function resolveImport(paths: Set<string>, specifier: string) {
  for (const candidate of [specifier, `${specifier}.ts`, `${specifier}.tsx`, `${specifier}/index.ts`, `${specifier}/index.tsx`]) if (paths.has(candidate)) return candidate;
  return null;
}

// 纯静态的完整性检查：不依赖模型判断，专门拦截“看起来做完了，其实没做完”的情况。
export function analyzeProject(files: WorkspaceFile[]): ProjectIssue[] {
  const issues: ProjectIssue[] = [];
  const paths = new Set(files.map((file) => file.path));
  const byPath = new Map(files.map((file) => [file.path, file]));
  const app = byPath.get("src/app/App.tsx")?.content ?? "";
  const routes = manifestRoutes(files);
  // "/" 可能作为 App.tsx 的默认分支渲染；/404 由 NotFoundPage 兜底。
  const registered = new Set(routes.filter((route) => route === "/" || app.includes(`"${route}"`) || app.includes(`'${route}'`)));
  for (const route of routes) if (!registered.has(route) && route !== "/404") issues.push({ file: "src/app/App.tsx", severity: "error", message: `路由 ${route} 在 site-manifest.ts 中声明了，但没有在 App.tsx 注册，访问时不会显示对应页面` });

  const sourceFiles = files.filter((file) => file.path.startsWith("src/") && /\.(tsx?|css)$/.test(file.path));
  const codeFiles = sourceFiles.filter((file) => /\.tsx?$/.test(file.path) && file.path !== "src/app/router.tsx" && file.path !== "src/main.tsx");

  // App.tsx 实际渲染的页面
  const appFile = byPath.get("src/app/App.tsx");
  const routedPages = new Set(appFile ? localImports(appFile).map((specifier) => resolveImport(paths, specifier)).filter((item): item is string => !!item && item.startsWith("src/pages/")) : []);
  for (const file of files.filter((item) => /^src\/pages\/[^/]+\.tsx$/.test(item.path))) {
    if (!routedPages.has(file.path)) { issues.push({ file: file.path, severity: "warning", message: `${file.path} 没有被 App.tsx 使用` }); continue; }
    if (file.content.includes(STUB_MARKER)) issues.push({ file: file.path, severity: "error", message: `${file.path} 仍是系统生成的页面骨架，页面内容还没有实现` });
    const template = templateFiles[file.path as keyof typeof templateFiles];
    if (template && template === file.content && file.path !== "src/pages/NotFoundPage.tsx") issues.push({ file: file.path, severity: "error", message: `${file.path} 与模板完全相同，页面没有按本次需求改写` });
  }

  // 占位文案和模板残留
  const scanned = codeFiles.filter((file) => file.path !== "src/pages/NotFoundPage.tsx");
  for (const file of scanned) {
    const source = stripComments(file.content);
    for (const [pattern, label] of placeholderPatterns) {
      const match = pattern.exec(source);
      if (!match) continue;
      issues.push({ file: file.path, severity: "error", message: `${file.path} 含有${label}「${snippetAround(source, match.index)}」，请替换成具体可信的内容` });
      break;
    }
    const residue = templatePagePhrases.find((phrase) => source.includes(phrase));
    if (residue) issues.push({ file: file.path, severity: "error", message: `${file.path} 仍保留模板示例文案「${residue}」` });
  }

  // 内部链接必须指向已注册路由
  const linkPattern = /\b(?:to|href|path|link|url|cta)\w*\s*[:=]\s*\{?\s*["'`](#?\/[a-zA-Z0-9\-/]*)(?:[?#][^"'`]*)?["'`]/g;
  for (const file of codeFiles) {
    if (file.path === "src/app/site-manifest.ts" || file.path === "src/app/App.tsx") continue;
    const dead = new Set<string>();
    for (const match of stripComments(file.content).matchAll(linkPattern)) {
      const target = normalizeRoute(match[1]);
      if (!registered.has(target)) dead.add(target);
    }
    for (const target of dead) issues.push({ file: file.path, severity: "error", message: `${file.path} 链接到未注册的路由 ${target}，请改成已注册路由（${[...registered].join("、")}）或新增并注册该页面` });
  }

  // 导入的本地文件必须存在。TypeScript 不检查 import "./x.css" 这类副作用导入，
  // 只有 Vite 构建才会报错，所以在这里提前拦下来，让页面 Agent 自己就能发现。
  for (const file of codeFiles) {
    for (const specifier of localImports(file)) {
      if (!resolveImport(paths, specifier)) issues.push({ file: file.path, severity: "error", message: `${file.path} 导入的文件 ${specifier} 不存在，请创建它或删除这个导入` });
    }
  }

  // 写了数据却没用上
  const importedByOthers = new Set(codeFiles.flatMap((file) => localImports(file).map((specifier) => resolveImport(paths, specifier)).filter((item): item is string => !!item)));
  for (const file of files.filter((item) => /^src\/(content|components)\/.+\.tsx?$/.test(item.path))) {
    if (!importedByOthers.has(file.path)) issues.push({ file: file.path, severity: file.path.startsWith("src/content/") ? "error" : "warning", message: `${file.path} 没有被任何页面或组件导入，${file.path.startsWith("src/content/") ? "数据没有展示到网站上" : "是未使用的组件"}` });
  }
  return issues;
}

// 页面“拥有”的文件：页面本身，以及它（递归）导入的页面专属数据、区块和样式。
// 全站共用的 src/content/site.ts 不算。
export function ownedFiles(files: WorkspaceFile[], pageFile: string) {
  const paths = new Set(files.map((file) => file.path));
  const byPath = new Map(files.map((file) => [file.path, file]));
  const owned = new Set<string>();
  const queue = [pageFile];
  while (queue.length) {
    const current = queue.shift()!;
    if (owned.has(current) || !byPath.has(current)) continue;
    owned.add(current);
    for (const specifier of localImports(byPath.get(current)!)) {
      const resolved = resolveImport(paths, specifier);
      if (resolved && resolved !== "src/content/site.ts" && /^src\/(content|components\/sections|styles\/pages)\//.test(resolved)) queue.push(resolved);
    }
  }
  return [...owned];
}

// 评估用：每个页面的实现状态和代码量。
export function pageMetrics(files: WorkspaceFile[]) {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const app = byPath.get("src/app/App.tsx")?.content ?? "";
  const routeOf = new Map([...app.matchAll(/["'`](\/[a-z0-9\-/]*)["'`]\s*:\s*(\w+)/g)].map((match) => [match[2], match[1]]));
  return files.filter((file) => /^src\/pages\/[^/]+\.tsx$/.test(file.path) && file.path !== "src/pages/NotFoundPage.tsx").map((file) => {
    const owned = ownedFiles(files, file.path);
    const component = path.posix.basename(file.path, ".tsx");
    return {
      route: routeOf.get(component) ?? "?",
      file: file.path,
      stub: file.content.includes(STUB_MARKER),
      codeBytes: owned.filter((item) => /\.tsx?$/.test(item)).reduce((total, item) => total + (byPath.get(item)?.content.length ?? 0), 0),
      cssBytes: owned.filter((item) => item.endsWith(".css")).reduce((total, item) => total + (byPath.get(item)?.content.length ?? 0), 0),
      files: owned.length,
    };
  });
}

// 页面 Agent 只需要关心自己负责的文件及其导入的本地文件。
export function pageIssues(files: WorkspaceFile[], pageFile: string, minChars = 2500) {
  const paths = new Set(files.map((file) => file.path));
  const byPath = new Map(files.map((file) => [file.path, file]));
  const page = byPath.get(pageFile);
  if (!page) return [`${pageFile} 不存在`];
  const owned = new Set([pageFile]);
  for (const specifier of localImports(page)) {
    const resolved = resolveImport(paths, specifier);
    if (resolved && /^src\/(content|components\/sections|styles\/pages)\//.test(resolved)) owned.add(resolved);
  }
  const issues = analyzeProject(files).filter((issue) => issue.severity === "error" && owned.has(issue.file)).map((issue) => issue.message);
  const size = [...owned].filter((file) => /\.tsx?$/.test(file)).reduce((total, file) => total + (byPath.get(file)?.content.length ?? 0), 0);
  if (size < minChars) issues.push(`${pageFile} 及其数据文件总共只有 ${size} 个字符，页面内容过少，请按设计文档补齐区块`);
  return issues;
}

export type ContentQuality = { ok: boolean; errors: string[]; warnings: string[]; score: number };

export function inspectContentQuality(files: WorkspaceFile[]): ContentQuality {
  const errors: string[] = [];
  const warnings: string[] = [];
  const prd = files.find((file) => file.path === "docs/prd.md")?.content ?? "";
  const design = files.find((file) => file.path === "docs/design.md")?.content ?? "";
  const sitePlanRaw = files.find((file) => file.path === "docs/site-plan.json")?.content ?? "";
  const pageFiles = files.filter((file) => /^src\/pages\/[^/]+\.(tsx|ts)$/.test(file.path));

  if (!prd.trim()) warnings.push("缺少 docs/prd.md，需求分析没有落盘");
  else if (prd.trim().length < 900) errors.push("docs/prd.md 内容过短，缺少页面目的、内容要求或验收标准");
  if (!design.trim()) warnings.push("缺少 docs/design.md，设计推导没有落盘");
  else {
    if (design.trim().length < 1800) errors.push("docs/design.md 内容过短，缺少页面内容蓝图或实现规则");
    for (const keyword of ["区块", "图像", "文案", "多端", "验收"]) if (!design.includes(keyword)) warnings.push(`design.md 没有明确写出${keyword}规则`);
  }
  if (sitePlanRaw.trim()) {
    try {
      const sitePlan = JSON.parse(sitePlanRaw) as { pages?: Array<{ name?: string; contentGoals?: unknown[]; recommendedContent?: unknown[] }> };
      for (const page of sitePlan.pages ?? []) {
        if (!Array.isArray(page.contentGoals) || page.contentGoals.length === 0) errors.push(`${page.name || "未命名页面"} 缺少内容目标`);
        if (!Array.isArray(page.recommendedContent) || page.recommendedContent.length === 0) warnings.push(`${page.name || "未命名页面"} 缺少内容深度建议`);
      }
    } catch { errors.push("docs/site-plan.json 不是有效的页面计划"); }
  }

  for (const issue of analyzeProject(files)) if (issue.severity === "error" && /占位|模板示例|示例域名|TODO|lorem/.test(issue.message)) errors.push(issue.message);
  if (pageFiles.length < 3) warnings.push("页面数量较少，建议确认 PRD 中的页面是否都已实现");
  const pageWithHero = pageFiles.filter((file) => file.content.includes("PageHero") || file.content.includes("hero")).length;
  if (pageFiles.length > 0 && pageWithHero < Math.max(1, Math.ceil(pageFiles.length / 2))) warnings.push("多数页面缺少明确的页面首屏或页面标题区");
  const score = Math.max(0, Math.min(100, 100 - errors.length * 22 - warnings.length * 7));
  return { ok: errors.length === 0, errors, warnings, score };
}

export async function checkWorkspace(root: string) {
  const files = await listWorkspaceFiles(root);
  const paths = new Set(files.map((file) => file.path));
  const errors: string[] = [];
  const warnings: string[] = [];
  const required = ["AGENT.md", "skills/requirements/SKILL.md", "skills/design-derivation/SKILL.md", "skills/site-review/SKILL.md", "design/tokens.json", "src/app/App.tsx", "src/app/site-manifest.ts", "src/layouts/SiteLayout.tsx", "src/styles/tokens.css", "src/styles/globals.css"];
  for (const file of required) if (!paths.has(file)) errors.push(`缺少骨架文件：${file}`);
  const app = files.find((file) => file.path === "src/app/App.tsx")?.content ?? "";
  const manifest = files.find((file) => file.path === "src/app/site-manifest.ts")?.content ?? "";
  const index = files.find((file) => file.path === "index.html")?.content ?? "";
  const main = files.find((file) => file.path === "src/main.tsx")?.content ?? "";
  const tokens = files.find((file) => file.path === "src/styles/tokens.css")?.content ?? "";
  if (!app.includes("SiteLayout")) errors.push("路由没有使用统一 SiteLayout");
  if (!manifest.includes("routes")) errors.push("站点路由清单缺少 routes");
  if (!main.includes("createRoot")) errors.push("入口没有使用 React createRoot");
  if (!index.includes('id="root"')) errors.push("index.html 缺少 root 挂载节点");
  for (const issue of analyzeProject(files)) {
    if (issue.severity === "warning") warnings.push(issue.message);
    else if (!/占位|模板示例|示例域名|TODO|lorem/.test(issue.message)) errors.push(issue.message);
  }
  for (const token of ["--color-brand", "--color-accent", "--layout-max", "--space-section"]) if (!tokens.includes(token)) errors.push(`设计令牌缺少 ${token}`);
  for (const file of files.filter((item) => item.path.startsWith("src/pages/") && /\.(tsx|ts)$/.test(item.path))) if (!file.content.includes("Section") && !file.content.includes("PageHero") && !file.content.includes("components/")) warnings.push(`${file.path} 没有复用任何共享组件`);
  const content = inspectContentQuality(files);
  errors.push(...content.errors);
  warnings.push(...content.warnings);
  return { ok: errors.length === 0, errors, warnings, contentScore: content.score, fileCount: files.length };
}

export function previewDocument(files: WorkspaceFile[]) {
  const html = files.find((file) => file.path === "site.html")?.content;
  if (!html) return "";
  const css = files.find((file) => file.path === "styles.css")?.content ?? "";
  const script = files.find((file) => file.path === "script.js")?.content ?? "";
  const withCss = html.includes("</head>") ? html.replace("</head>", `<style>${css}</style></head>`) : `<style>${css}</style>${html}`;
  return withCss.includes("</body>") ? withCss.replace("</body>", `<script>${script}</script></body>`) : `${withCss}<script>${script}</script>`;
}
