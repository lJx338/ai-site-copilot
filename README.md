# AI 建站 Copilot（DeepSeek 第一版）

这是一个真实模型驱动的建站 Copilot 工作台：左侧是当前会话，右侧展示当前生成的网站。每次需求都会经过“需求分析 → 结构化计划 → 工具执行 → 项目检查 → 预览构建 → 失败自动修复”的工作流；过程通过 NDJSON 流实时显示，只有新版本构建成功后才切换预览。DeepSeek API Key 在顶部栏输入并缓存到当前浏览器本地，聊天会话不会持久化，重新打开工作台会清空。

## 启动

```sh
cp .env.example .env.local
# 编辑 .env.local，填入 DEEPSEEK_API_KEY
pnpm run dev
```

打开 `http://localhost:5173/`。也可以直接在右侧 Copilot 面板的 “DeepSeek API Key” 输入框粘贴 Key；默认模型为官方当前的 `deepseek-flash`，可用 `DEEPSEEK_MODEL` 改成 `deepseek-v4-pro`。

当前主链路：

0. **意图识别**：每条消息先用一次不开深度思考的快速调用（参考最近 8 轮对话和项目现状）分成四类，再决定走哪条流程：
   - `new_site`（新建/重做）：走下面完整的 1–5 步；
   - `modify`（修改）：跳过规划，修改 Agent 直接开工，然后校验；
   - `fix`（修复）：不调用 Agent，直接构建和检查，发现问题才进入修复；
   - `ask`（提问/只读检查）：只读回答，不构建、不校验。
   配置了 `TYPESAFE_API_KEY` 时优先用 TypeSafe Jev（`lib/intent-jev.ts`）：一个 Choice 问题判断意图，再并行问“是否明确要求不改文件”和“每个页面是否相关”的 Noul 问题，由代码组合结果；Jev 置信度低于 `TYPESAFE_MIN_CONFIDENCE`（默认 0.7）或调用失败时，改用不开深度思考的 DeepSeek 调用判断。识别调用全部失败时按关键词兜底；项目还是模板时，除提问外一律按新建处理。LLM 内容审查只在新建网站时运行。每个事件都会以 `[agent:<projectId>]` 前缀打印在 dev 服务终端里。
1. **规划**：先让 DeepSeek 输出一份精简的 JSON 页面计划（mode、品牌、页面和路由），再分别生成纯 Markdown 的 `docs/prd.md` 和 `docs/design.md`（含“内容事实表”和按 `### 页面名（/route）` 划分的页面蓝图）。长文档不再塞进 JSON，避免输出截断导致计划为空。局部修改沿用已有文档。
2. **新建网站**：代码先生成路由骨架（`site-manifest.ts`、`App.tsx` 路由表、带 `@ai-stub` 标记的页面文件），然后由“全站基础” Agent 负责设计令牌、全局样式、Header/Footer、`src/content/site.ts` 和 `docs/content-todo.md`，最后每个页面各跑一个页面 Agent（并发 3 个），只能写自己的页面文件、`src/content/<slug>.ts`、`src/styles/pages/<slug>.css` 和 `src/components/sections/<Page>*`。
3. **局部修改**：单个 Agent，上下文（设计文档、路由、相关页面）预先附在消息里，不再浪费轮数去读文件。
4. **自动验证**：每个 Agent 结束回复后，系统自动运行完整性检查和 TypeScript 检查，把问题发回同一段对话继续修复。完整性检查会拦截：未注册的路由、指向未注册路由的链接、仍是骨架或与模板相同的页面、模板示例文案、`{占位}`/“待确认”/example.com 等占位写法，以及没有被使用的 `src/content` 数据文件。
5. **整站校验**：Vite 构建 → 完整性检查 → 无头浏览器逐页打开（白屏、运行时报错、回退到首页或 404 的路由、死链）→ LLM 内容审查。所有问题汇总后交给修复阶段，最多 3 轮；仍是骨架的页面会重新交给页面 Agent。

运行观测：每次请求都会记录每次模型调用（阶段、Agent、轮次、输入 token 的缓存命中/未命中、输出与思考 token、截断、耗时、按调用时间的高峰/空闲价估算费用）、每次工具调用、每个 Agent 的轮数和结束方式、自检结果、每轮校验和修复面对的问题。结束时在 dev 终端打印汇总表，并把 `report.json`、`summary.txt` 和每个 Agent 的完整对话保存在 `.ai-site-copilot-workspaces/.runs/<runId>/`（`latest.txt` 指向最近一次）。价格表在 `lib/telemetry.ts`，可用 `DEEPSEEK_PRICE_*` 覆盖。

Agent 执行约束：每个写代码的 Agent 一开始就知道自己的轮数预算，剩 3 轮以内会被要求停止阅读、立即写入；页面 Agent 第 1 轮同时写出页面、数据和样式文件，只能用读/写/补丁三个工具，不能读取其他页面；机械性问题（缺失的样式文件、未注册的路由）由 `autoFixProject()` 直接修复；修复阶段按"代码自动修复 → 重跑骨架页的页面 Agent → 只把剩余问题交给修复 Agent"升级。写代码 Agent 的思考强度由 `AI_AGENT_REASONING_EFFORT` 控制（默认 high）。

评估：每次运行在 `.ai-site-copilot-workspaces/.runs/<runId>/` 归档成品（`site/`、单文件 `site.html`）、桌面和手机整页截图（`screens/`）和逐页渲染数据（`render.json`）。用 `npm run compare:runs -- <基线 runId> [新 runId]` 对比两次运行的费用、用时、Agent 行为、修复过程和页面质量。

视觉评估：截图前会先滚动页面、关闭动画，并把 sticky/fixed 元素改回普通定位，避免整页截图错位。浏览器视觉检查会找出横向溢出、文字或图形被裁切、图片加载失败、对比度不足、手机上过小的文字和点击区域、过长的手机页面，分"必须修"和"建议修"两级。看图审查由 `deepseek-flash` 直接读取按屏切片的截图，从视觉层次、节奏、图片、排版、一致性、手机端 6 个维度打分并列出问题，整站约 ¥0.1。新建网站结束时自动运行，结果记入报告（目前只记录，不触发修复）。已有项目可以用 `npm run visual:review -- [runId]` 补做（同一站点多次打分会有约 ±3 分的波动），用 `npm run gallery -- <runA> [runB]` 生成截图对比页。

配图：页面用 `<SiteImage slot kind query prompt ratio alt>` 声明需要什么图，不写图片地址。每轮校验前，预览服务在浏览器里渲染页面、收集所有 `data-image-*` 图片位，照片先搜 Pexels（`PEXELS_API_KEY`），产品图先用 Seedream 生成（`ARK_API_KEY`、`ARK_IMAGE_MODEL`、`ARK_IMAGE_URL`，每站最多 `IMAGE_AI_MAX` 张，默认 12，产品图优先；注意 plan 接口目前只接受 `doubao-seedream-5.0-pro`，`5.0-lite` 会返回 UnsupportedModel；单张约 30 秒）；一种来源失败就换另一种，原因会记进进度和报告。图片用 sharp 压成 WebP，保存在 `.ai-site-copilot-workspaces/.assets/<projectId>/`，按描述缓存，由预览服务的 `/assets/` 提供访问，地址写进 `src/content/images.ts`。Pexels 图片会显示摄影师署名和来源链接。设计文档的“图像风格”会拼进 AI 生图提示词，保证风格统一。

区块库：模板里的 `src/components/blocks/` 提供 13 个做好版式、手机端、动效和配图的页面积木（Hero 三种变体、LogoCloud、StatsBand、FeatureGrid、SplitFeature、ProductGrid、Gallery、Testimonials、Steps、Pricing、Faq、CtaBand、ContactBlock），样式在 `src/styles/blocks.css`，只依赖 tokens.css 的变量名。目录和用法在 `skills/blocks/SKILL.md`，页面 Agent 预先拿到目录，优先组合区块、不合适时自己写；区块库、SiteImage 和图片清单对所有 Agent 只读。全站基础阶段必须保留模板里的全部令牌名。用全部区块拼成的样例页在默认主题下视觉审查约 80 分，生成网站目前约 66 分。

内容策略：用户没提供的事实由 Agent 补全成可信、具体、全站一致的示例内容，并列在 `docs/content-todo.md` 里方便替换；页面上不允许出现占位写法。

浏览器检查会依次查找 `CHROME_PATH`、Playwright 缓存里的 headless shell（最快）和系统安装的 Chrome/Chromium/Edge；都找不到时跳过，不阻塞建站。`DEEPSEEK_MAX_TOKENS` 是单次请求的输出上限（含思考，默认 128000，模型最多 384000），只用来防止失控，不用来压缩产出。**所有配置都要写在 `.env.local` 里**：API 运行在 Cloudflare Workers 运行时中，看不到在命令行里 `export` 或前缀传入的环境变量。

`pnpm run dev` 会同时启动工作台和本地预览构建服务：Vinext API 请求使用临时工作区，预览子进程把项目快照保存在被 Git 忽略的 `.ai-site-copilot-workspaces/.preview-workspaces`，每次请求开始时临时工作区会与快照完全对齐。可通过 `AI_WORKSPACE_ROOT` 指定 API 临时工作区、通过 `AI_PREVIEW_WORKSPACE_ROOT` 指定持久化预览工作区。

## 结构

- `app/page.tsx`：Copilot 工作台和生成网站预览
- `app/api/agent/stream/route.ts`：分阶段建站工作流和 NDJSON 流式事件接口
- `app/api/copilot/route.ts`：DeepSeek Chat Completions 接口适配
- `app/api/agent/route.ts`：DeepSeek 工具调用 Agent，执行项目文件读写、精确补丁和项目检查
- `app/api/preview/route.ts`：从持久化预览工作区读取并返回真实项目的 Vite 预览
- `lib/project-workspace.ts`：项目工作区、文件白名单、路由骨架生成、补丁和完整性检查
- `lib/preview-client.ts`：与预览服务通信（快照同步、构建、类型检查、浏览器检查）
- `lib/project-template.ts`：嵌入运行时的 React 项目模板，避免部署环境依赖源码路径
- `lib/agent-workflow.ts`：页面计划、分阶段 Agent（全站基础 / 页面 / 修改 / 修复 / 只读审计）和自动验证
- `lib/site-model.ts`：站点结构协议和类型
- `templates/site-project/`：供 Agent 使用的 React + TypeScript + Vite 多页面项目骨架
- `scripts/preview-server.mjs`：开发模式下的本地预览服务，提供 Vite 构建、`/typecheck` 和无头浏览器 `/inspect`
- `.env.example`：DeepSeek 配置模板

---

A clean full-stack starter running on [vinext](https://github.com/cloudflare/vinext), with optional Cloudflare D1 and Drizzle support.

## Prerequisites

- Node.js `>=22.13.0`
- Portable: Windows, macOS, or Linux; no Bash required
- Managed Linux: managed Linux runtime with Bash, `flock`, `curl`, `sha256sum`, and GNU `timeout`
- Git is required only for publishing

## Sites Lifecycle

The Sites initializer copies the shared starter and selects managed-linux only when `SITES_MANAGED_LINUX_CONTAINER=1`; otherwise it selects portable. It saves the selection only in ignored `.sites-runtime/execution-profile.json`. Both profiles copy/configure first, then use the plugin's separate `install-dependencies.mjs` step to measure installation independently. Edit source under `app/` and follow the Sites skill for installation, preview, builds, and publishing.

Run `node <plugin-root>/scripts/configure-execution-profile.mjs` only when the profile is unknown for the current checkout and environment. Profile changes do not alter tracked source or require reinstalling otherwise-valid dependencies; restart an existing preview to use the new selection. Do not commit or upload `.sites-runtime/`.

This starter does not use `wrangler.jsonc`.

`install:ci` runs `npm ci` once against the shared lockfile, disables parent-workspace discovery, and includes required dev/optional dependencies despite production/omit settings. Sharp defaults to prebuilt binaries unless explicitly configured otherwise. Do not overlap installers.

- **Portable:** Preserve host HOME, npm cache, registry, proxy, temporary paths, retry/concurrency settings, and lifecycle-script policy. Use `--prefer-offline --no-audit --no-fund`.
- **Managed Linux:** Use the existing project-local HOME/cache/tmp setup and Linux install lock, tarball preflight, and timeout. Restore the image-seeded npm cache only when its lockfile hash matches; retain network fallback. Builds keep their existing timeout. These helpers are not invoked by the portable profile.

`scripts/sites-env.mjs` preserves the caller's HOME, npm cache, proxy, XDG, and temporary-directory configuration while defaulting Wrangler and Miniflare state to the checkout. If npm reports an unwritable cache, select a writable path with `npm_config_cache` for that install. The `dev` and `start` scripts also keep Wrangler logs inside the checkout. Generated `.sites-runtime/` and `.wrangler/` directories are disposable and ignored by Git.

On portable, `npm run dev` uses `vinext dev` with HMR, starting at port 5173. Vinext records the running server in ignored `.vinext/` state, rejects an ordinary duplicate launch, and recovers stale state after a stopped process; exactly simultaneous starts can race. Pass `--port <port>` or `--hostname <host>` after `npm run dev --` when needed; keep portable previews on loopback.

For browser QA on managed Linux, use `sites-preview start`. The project's dev script runs Vite and accepts the supervisor's `--host 0.0.0.0 --port 4173 --strictPort` arguments. The internal browser uses `http://terminal.local:4173/`; it is not a user-facing URL. The supervisor owns the preview lifecycle. The ignored local profile survives the supervisor's cleared process environment.

The portable profile simulates ChatGPT sign-in only for loopback development requests. Visit `/signin-with-chatgpt?return_to=/` to sign in as `local_seedy` (`seedy@sites.test`, display name `Seedy`) and `/signout-with-chatgpt?return_to=/` to sign out. The development cookie preserves that identity across server restarts. Mock auth is disabled in the managed-linux profile and is not included in production builds; hosted authentication remains dispatch-owned.

The Worker uses `vinext/server/fetch-handler`, including Vinext's config-aware image handling. After building, `npm start` runs that Worker locally through Wrangler on `127.0.0.1`, sharing `.wrangler/state` with dev preview and local D1 migrations; it does not deploy the site or simulate sign-in. Use the URL printed by the server. Pass `npm start -- --port <port>` to select a different built-preview port.

Local previews use Miniflare's placeholder `Request.cf` metadata without a network lookup. Set `CLOUDFLARE_CF_FETCH_ENABLED=true` to opt into fetching preview metadata; this setting does not change hosted request metadata.

Local tool usage metrics are disabled by default. Set `WRANGLER_SEND_METRICS=true` to opt in.

## Included Shape

- edit site code under `app/`
- `app/chatgpt-auth.ts` provides optional dispatch-owned ChatGPT sign-in helpers
- `.openai/hosting.json` declares optional Sites D1 and R2 bindings
- `vite.config.ts` simulates declared bindings for local development
- `db/index.ts` reads the D1 binding from the Cloudflare Worker environment
- `db/schema.ts` starts intentionally empty
- `@cloudflare/workers-types` provides Worker types; `cloudflare-env.d.ts` declares optional `DB`/`BUCKET` bindings—update these declarations if binding names change
- `examples/d1/` contains an optional D1 example surface
- `drizzle.config.ts` supports local migration generation when needed

## Workspace Auth Headers

Signed-in visitors receive both `oai-authenticated-user-id` and `oai-authenticated-user-email`. Private Sites require every visitor to sign in; public Sites may also have anonymous visitors, for whom neither header is present.

The user ID is stable for the same user on the same Site and different across Sites. Use it as the durable user key; use email and name for display or contact purposes.

SIWC-authenticated workspace sites may also receive `oai-authenticated-user-full-name` when the user's SIWC profile has a non-empty `name` claim. The full-name value is percent-encoded UTF-8 and is accompanied by `oai-authenticated-user-full-name-encoding: percent-encoded-utf-8`.

Treat the full name as optional and fall back to email when it is absent:

```tsx
import { headers } from "next/headers";

export default async function Home() {
  const requestHeaders = await headers();
  const userId = requestHeaders.get("oai-authenticated-user-id");
  const email = requestHeaders.get("oai-authenticated-user-email");
  const encodedFullName = requestHeaders.get("oai-authenticated-user-full-name");
  const fullName =
    encodedFullName &&
    requestHeaders.get("oai-authenticated-user-full-name-encoding") ===
      "percent-encoded-utf-8"
      ? decodeURIComponent(encodedFullName)
      : null;

  const displayName = fullName ?? email;
  // ...
}
```

## Optional Dispatch-Owned ChatGPT Sign-In

Import the ready-to-use helpers from `app/chatgpt-auth.ts` when the site needs optional or required ChatGPT sign-in:

- Use `getChatGPTUser()` for optional signed-in UI.
- Use the returned `userId` as the stable user key for user-owned records; do not use email as a durable identifier.
- Use `requireChatGPTUser(returnTo)` for server-rendered pages that should send anonymous visitors through Sign in with ChatGPT.
- In a Server Component, start sign-in with `<a href={chatGPTSignInPath(returnTo)} target="_top">`. The auth helper module is server-only; do not import it into a Client Component.
- Do not use `fetch`, XHR, a client-side router, or a framework link that can prefetch the sign-in route. SIWC must start as a top-level navigation.
- Never request the AuthAPI authorization endpoint directly. The dispatch-owned `/signin-with-chatgpt` route must start the SIWC flow.
- Use `chatGPTSignOutPath(returnTo)` for browser sign-out links or actions.
- Pass a same-origin relative `returnTo` path for the destination after sign-in or sign-out. The helper validates and safely encodes it.
- Mark protected pages with `export const dynamic = "force-dynamic"` because they depend on per-request identity headers.

Dispatch owns `/signin-with-chatgpt`, `/signout-with-chatgpt`, `/callback`, the OAuth cookies, and identity header injection. Do not implement app routes for those reserved paths. Routes that do not import and call the helper remain anonymous-compatible.

SIWC establishes identity only; it does not prove workspace membership. Use the Sites hosting platform's access policy controls for workspace-wide restrictions, or enforce explicit server-side membership or allowlist checks.

Use SIWC for account pages, user-specific dashboards, saved records, and write actions tied to the current ChatGPT user. Leave public content anonymous.

## Local D1 migrations

For a D1-backed local preview, generate SQL with `npm run db:generate`. Build once through the Sites skill's build entrypoint (or `npm run build` for standalone use) to generate `dist/server/wrangler.json`, rebuilding if bindings change. From the project root, apply each pending migration in order:

```sh
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_example.sql
```

Replace the filename with the pending migration and `DB` with your D1 binding name if different. Use `.wrangler/state`, not `.wrangler/state/v3`; Wrangler adds the versioned directories. Do not replay migrations already applied locally. This updates only the preview database; publishing applies production migrations separately.

## Diagnostic Commands

- `npm run install:ci`: perform the one locked dependency install
- `npm run dev`: start the Vite/Vinext development server
- `npm run build`: build the deployable Sites artifact
- `npm run start`: preview the built Worker locally with D1/R2 support
- `npm run db:generate`: generate Drizzle migrations after schema changes

When using the Sites plugin, follow its skill instructions for installation, builds, and publishing. These npm commands remain available for standalone use.

The portable build runs Vinext directly without a host `timeout` command. The managed-linux build uses `scripts/build-verified.sh` and its existing `SITES_BUILD_TIMEOUT` setting.

## Learn More

- [vinext Documentation](https://github.com/cloudflare/vinext)
- [Drizzle D1 Guide](https://orm.drizzle.team/docs/get-started/d1-new)
