// 读取用户上传的资料，提炼成客户资料卡（materials/brief.md），供规划、设计和页面 Agent 使用。
// 流程：预览服务解析文件（纯代码）→ 看图模型识别图片和整页图 → 文本模型提炼资料卡。
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { deepSeekRequest, requestJson, type ChatMessage, type WorkflowEmitter } from "./agent-workflow";
import { BRIEF_FILE, BRIEF_JSON } from "./materials-brief";
import { ingestMaterialFiles, type MaterialImage, type MaterialIndex } from "./preview-client";
import { enterStage } from "./telemetry";

const IMAGE_KINDS = ["logo", "certificate", "product", "workshop", "equipment", "team", "office", "event", "portrait", "document", "background", "decoration", "other"] as const;
type ImageKind = (typeof IMAGE_KINDS)[number];
const KIND_LABELS: Record<ImageKind, string> = { logo: "logo", certificate: "证书/奖牌", product: "产品", workshop: "车间/产线", equipment: "设备", team: "团队/人物", office: "办公环境", event: "活动", portrait: "人物照", document: "文档截图", background: "背景底图", decoration: "装饰", other: "其他" };

export type ImageNote = { id: string; kind: ImageKind; subject: string; text: string; usable: boolean; note: string };
type Fact = { label: string; value: string; source: string };
export type MaterialsBrief = {
  brand: { name: string; nameEn: string; shortName: string; tagline: string; colors: string[]; logoAsset: string };
  sections: Array<{ title: string; facts: Fact[] }>;
  conflicts: Array<{ topic: string; options: Array<{ value: string; source: string }>; suggestion: string }>;
  gaps: Array<{ topic: string; suggestion: string }>;
  risks: Array<{ item: string; reason: string }>;
  images: Array<ImageNote & { width: number; height: number; grade: MaterialImage["grade"]; from: string; fit: string }>;
};

async function mapLimit<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>) {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await task(items[index]); }
  }));
  return results;
}

const text = (value: unknown, max = 400) => (typeof value === "string" ? value.trim().slice(0, max) : "");
const imagePart = (b64: string) => ({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}`, detail: "high" } });

// 看图请求：图片只能放在 user 消息的内容块里；带图片的请求会自动改用 DEEPSEEK_VISION_MODEL。
async function visionRequest(apiKey: string, system: string, content: unknown[], purpose: string, json: boolean) {
  const messages = [{ role: "system", content: system }, { role: "user", content }] as unknown as ChatMessage[];
  const options = { purpose, reasoningEffort: "none" as const, ...(json ? { responseFormat: { type: "json_object" as const } } : {}) };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { message } = await deepSeekRequest(apiKey, messages, options);
    if (!json) return message.content || "";
    try { JSON.parse(message.content || ""); return message.content || ""; } catch { /* retry once */ }
  }
  throw new Error("看图识别没有返回有效 JSON");
}

const classifyPrompt = `你在整理一家企业上传的资料图片，为建设官网挑选素材。逐张判断，只输出 JSON：
{"images":[{"id":"m1","kind":"${IMAGE_KINDS.join("|")}","subject":"画面内容，中文 25 字以内","text":"图中能读出的关键文字：logo 上的公司或品牌名、证书名称和颁发机构、设备型号；没有就写空字符串","usable":true,"note":"不适合放上官网的原因（模糊、纯底图、画面残缺、含身份证手机号等隐私），适合就写空字符串"}]}
kind 说明：logo 是公司或品牌标志；certificate 是证书、牌匾、奖杯；background 是没有主体的底图、渐变、纹理；decoration 是图标、线条、边框这类装饰。`;

// 看图失败的原因。401/402（key 无效、余额不足）时后面的请求也会失败，直接停止，不再浪费时间。
type VisionState = { error: string; fatal: boolean };
const recordVisionError = (state: VisionState, error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  if (!state.error) state.error = message.slice(0, 160);
  if (/HTTP 40[12]/.test(message)) state.fatal = true;
};

async function classifyImages(apiKey: string, images: MaterialImage[], state: VisionState) {
  const candidates = images.filter((image) => image.b64 && image.grade !== "blank");
  const batches: MaterialImage[][] = [];
  for (let i = 0; i < candidates.length; i += 8) batches.push(candidates.slice(i, i + 8));
  const notes = new Map<string, ImageNote>();
  await mapLimit(batches, 3, async (batch) => {
    if (state.fatal) return;
    const content = [
      { type: "text", text: `共 ${batch.length} 张图片，按顺序给出每张的判断，id 必须和下面的标注一致。` },
      ...batch.flatMap((image) => [{ type: "text", text: `图 ${image.id}：${image.from}，${image.width}×${image.height}` }, imagePart(image.b64)]),
    ];
    try {
      const parsed = JSON.parse(await visionRequest(apiKey, classifyPrompt, content, "materials_images", true)) as { images?: unknown[] };
      for (const raw of parsed.images ?? []) {
        const item = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
        const id = text(item.id, 12);
        if (!batch.some((image) => image.id === id)) continue;
        const kind = (IMAGE_KINDS as readonly string[]).includes(String(item.kind)) ? item.kind as ImageKind : "other";
        notes.set(id, { id, kind, subject: text(item.subject, 60), text: text(item.text, 120), usable: item.usable !== false, note: text(item.note, 80) });
      }
    } catch (error) {
      // 没识别出来的图片不进清单：不知道画面是什么，Agent 没法挑着用
      recordVisionError(state, error);
    }
  });
  return notes;
}

const pagePrompt = `你在读一家企业资料的一页（整页图 + 这一页的文字层；跨页画册会切成左半、右半分别给你，文字层是整页的）。文字层可能丢失表格结构，也读不到图片里的文字。
用 Markdown 输出下面几类信息，这一页都没有就写“无补充”：
- 表格：页面上只要有表格，就按图完整还原成 Markdown 表格（表头照抄，合并单元格按行展开，每一行都写全项目和数值）。文字层里的表格一定是错位的，即使文字层里有同样的字也要还原，不能省略。
- 证书、奖牌、牌匾：逐个写出名称和颁发机构（能看清的）。
- logo：写出能认出的公司或品牌名。
- 照片：一句话概括这一页照片的主题（例如“车间 SMT 产线和 AOI 设备照片 12 张”）。
- 品牌视觉：如果这一页有这家企业自己的 logo 或主视觉，给出品牌主色的十六进制色值。
除了表格，不要复述文字层里已经有的内容；不要推测看不清的文字。`;

function pageTextLayer(index: MaterialIndex, from: string) {
  const match = from.match(/^(.*) 第 (\d+) 页(?:（.+）)?$/);
  if (!match) return "";
  const file = index.files.find((item) => item.name === match[1]);
  const section = (file?.text ?? "").split(/\n(?=## 第 \d+ 页)/).find((part) => part.startsWith(`## 第 ${match[2]} 页`));
  return (section ?? "").slice(0, 4000);
}

async function readPages(apiKey: string, index: MaterialIndex, state: VisionState) {
  const notes = await mapLimit(index.pages, 3, async (page) => {
    if (state.fatal) return "";
    try {
      const content = [{ type: "text", text: `资料：${page.from}\n\n这一页的文字层：\n${pageTextLayer(index, page.from) || "（没有文字层，可能是扫描件，请读出页面上的全部文字）"}` }, imagePart(page.b64)];
      return `### ${page.from}\n${(await visionRequest(apiKey, pagePrompt, content, "materials_pages", false)).trim()}`;
    } catch (error) {
      recordVisionError(state, error);
      return "";
    }
  });
  return notes.filter(Boolean).join("\n\n");
}

const extractPrompt = `你是企业官网的内容策划。根据客户上传的资料（表格、画册文字、看图补充、图片清单），整理成一份客户资料卡，后续的规划、设计和页面都以它为准。只输出 JSON：
{"brand":{"name":"公司全称","nameEn":"英文名","shortName":"品牌简称或 logo 字样","tagline":"资料里的一句话定位","colors":["#1F5C45"],"logoAsset":"企业自己 logo 的图片 ID，没有就空"},
"sections":[{"title":"分类","facts":[{"label":"条目","value":"内容","source":"出处：文件名 + 位置（第几行、第几页）"}]}],
"conflicts":[{"topic":"冲突点","options":[{"value":"说法一","source":"出处"}],"suggestion":"建议采用哪个、为什么"}],
"gaps":[{"topic":"官网通常需要但资料里没有的内容","suggestion":"建站时怎么处理"}],
"risks":[{"item":"需要客户确认的说法或素材","reason":"原因"}]}
要求：
- sections 按这些分类组织，没有内容的分类省略：公司概况、业务与服务、生产与交付能力、工艺与制程参数、资质荣誉与知识产权、客户与合作伙伴、目标客户与需求、企业文化、产品、联系方式、搜索关键词。
- value 忠实于原文：数字、年份、型号、参数、名称一字不改；长段落可以精简措辞，但不能丢数字、不能加入资料里没有的信息。同一事实多处出现只写一次，出处写最完整的那处。
- 表格里的填写说明、示例、必填标记是模板文字，不是事实，忽略。
- 图片里的信息（logo 认出的客户名、证书名称、还原的表格）也是事实，出处写图片 ID 或页码。
- PDF 文字层里的表格经常错位（表头、项目和数值分散在不同行）。只有看图补充里还原好的表格才逐项写参数；没有还原表格时，不要自己拼接项目和数值的对应关系，只写能确定的整句事实，并在 gaps 里注明“某页的表格需要看图还原”。
- conflicts：同一事实在不同资料里说法不一致时列出（例如年份、数量、交期、资质级别不同）。
- gaps：从官网访客的角度找缺口，例如客户案例细节、客户评价、团队介绍、价格或报价方式、交期细节、联系人、售后条款。
- risks：广告法绝对化用语（最、第一、顶级等）、与竞争对手比较的说法、需要授权的客户 logo、终身保修这类承诺、证书是否在有效期内。`;

function normalizeBrief(raw: Record<string, unknown>, images: MaterialImage[], notes: Map<string, ImageNote>): MaterialsBrief {
  const list = (value: unknown) => (Array.isArray(value) ? value : []).map((item) => (item && typeof item === "object" ? item : {}) as Record<string, unknown>);
  const brand = (raw.brand && typeof raw.brand === "object" ? raw.brand : {}) as Record<string, unknown>;
  const fit = (image: MaterialImage, note: ImageNote) => {
    if (!note.usable || image.grade === "tiny" || note.kind === "background" || note.kind === "decoration") return "不建议使用";
    if (note.kind === "logo") return "logo 条（LogoCloud 的 { name, asset }）";
    if (note.kind === "certificate") return "资质区块的证书小图";
    return image.grade === "large" ? "首屏、横幅、大图" : image.grade === "medium" ? "图文区块、卡片（显示宽度 720px 以内）" : "缩略图、网格小卡（显示宽度 360px 以内）";
  };
  return {
    brand: {
      name: text(brand.name, 80), nameEn: text(brand.nameEn, 120), shortName: text(brand.shortName, 40), tagline: text(brand.tagline, 120),
      colors: (Array.isArray(brand.colors) ? brand.colors : []).map((color) => text(color, 9)).filter((color) => /^#[0-9a-f]{6}$/i.test(color)).slice(0, 4),
      logoAsset: text(brand.logoAsset, 12),
    },
    sections: list(raw.sections).map((section) => ({ title: text(section.title, 30), facts: list(section.facts).map((fact) => ({ label: text(fact.label, 60), value: text(fact.value, 1200), source: text(fact.source, 120) })).filter((fact) => fact.value) })).filter((section) => section.title && section.facts.length),
    conflicts: list(raw.conflicts).map((item) => ({ topic: text(item.topic, 80), options: list(item.options).map((option) => ({ value: text(option.value, 200), source: text(option.source, 120) })), suggestion: text(item.suggestion, 200) })).filter((item) => item.topic),
    gaps: list(raw.gaps).map((item) => ({ topic: text(item.topic, 80), suggestion: text(item.suggestion, 200) })).filter((item) => item.topic),
    risks: list(raw.risks).map((item) => ({ item: text(item.item, 120), reason: text(item.reason, 200) })).filter((item) => item.item),
    images: images.filter((image) => notes.has(image.id)).map((image) => {
      const note = notes.get(image.id)!;
      return { ...note, width: image.width, height: image.height, grade: image.grade, from: image.from, fit: fit(image, note) };
    }),
  };
}

function renderBrief(brief: MaterialsBrief, files: MaterialIndex["files"]) {
  const lines = [`# 客户资料卡`, ``, `由上传资料自动整理（${files.map((file) => file.name).join("、")}）。建站时事实以此为准，括号里是出处。`, ``];
  const { brand } = brief;
  lines.push(`## 品牌`, ``, `- 名称：${brand.name}${brand.nameEn ? ` / ${brand.nameEn}` : ""}`);
  if (brand.shortName) lines.push(`- 简称 / logo 字样：${brand.shortName}`);
  if (brand.tagline) lines.push(`- 定位：${brand.tagline}`);
  if (brand.colors.length) lines.push(`- 品牌色：${brand.colors.join("、")}`);
  if (brand.logoAsset) lines.push(`- 企业 logo 图片：${brand.logoAsset}`);
  for (const section of brief.sections) {
    lines.push(``, `## ${section.title}`, ``);
    for (const fact of section.facts) lines.push(`- ${fact.label ? `${fact.label}：` : ""}${fact.value}${fact.source ? `（${fact.source}）` : ""}`);
  }
  if (brief.conflicts.length) {
    lines.push(``, `## 资料之间的冲突`, ``);
    for (const item of brief.conflicts) lines.push(`- ${item.topic}：${item.options.map((option) => `「${option.value}」（${option.source}）`).join(" vs ")}。建议：${item.suggestion}`);
  }
  if (brief.gaps.length) {
    lines.push(``, `## 资料里缺少的内容`, ``);
    for (const item of brief.gaps) lines.push(`- ${item.topic}：${item.suggestion}`);
  }
  if (brief.risks.length) {
    lines.push(``, `## 需要客户确认的风险`, ``);
    for (const item of brief.risks) lines.push(`- ${item.item}：${item.reason}`);
  }
  const usable = brief.images.filter((image) => image.fit !== "不建议使用");
  if (usable.length) {
    lines.push(``, `## 资料图片清单`, ``, `用法：<SiteImage asset="ID" ... />。不在清单里的图片不要用。`, ``, `| ID | 类型 | 画面 | 图中文字 | 尺寸 | 适合的位置 |`, `|---|---|---|---|---|---|`);
    for (const image of usable) lines.push(`| ${image.id} | ${KIND_LABELS[image.kind]} | ${image.subject.replace(/\|/g, "/")} | ${image.text.replace(/\|/g, "/")} | ${image.width}×${image.height} | ${image.fit} |`);
  }
  return `${lines.join("\n")}\n`;
}

// 给用户看的确认卡片：读到了什么、冲突、缺口、风险，确认后再建站
function renderCard(brief: MaterialsBrief, index: MaterialIndex, vision: VisionState & { images: number; pages: number }) {
  const count = (kind: ImageKind) => brief.images.filter((image) => image.kind === kind && image.fit !== "不建议使用").length;
  const facts = brief.sections.reduce((total, section) => total + section.facts.length, 0);
  const lines = [
    `我读完了资料：${index.files.map((file) => `${file.name}${file.error ? `（未能读取：${file.error}）` : ""}`).join("、")}。`,
    ``,
    `**${brief.brand.name || "品牌名未识别"}**${brief.brand.tagline ? ` · ${brief.brand.tagline}` : ""}${brief.brand.colors.length ? ` · 品牌色 ${brief.brand.colors.join(" ")}` : ""}`,
    ``,
    `整理出 ${facts} 条事实：${brief.sections.map((section) => `${section.title} ${section.facts.length}`).join("、")}。`,
  ];
  const usableCount = brief.images.filter((image) => image.fit !== "不建议使用").length;
  const kinds = (["product", "workshop", "equipment", "certificate", "logo", "team", "office", "event"] as ImageKind[]).map((kind) => count(kind) ? `${KIND_LABELS[kind]} ${count(kind)}` : "").filter(Boolean).join("、");
  lines.push(usableCount ? `可用图片 ${usableCount} 张：${kinds}。` : `没有可用的资料图片。`);
  if (vision.error) lines.push(``, `⚠️ **看图识别${vision.fatal ? "没有完成" : "部分失败"}**：${vision.error}。资料里有 ${vision.images} 张图片、${vision.pages} 页整页图，${vision.fatal ? "都没有识别，图片暂时不能用，图片和表格里的信息（logo、证书、参数表）也暂缺" : "没识别出来的图片暂时不能用"}。处理好以后重新发送一次资料即可。`);
  if (brief.conflicts.length) {
    lines.push(``, `**资料之间有 ${brief.conflicts.length} 处说法不一致：**`);
    brief.conflicts.forEach((item, i) => lines.push(`${i + 1}. ${item.topic}：${item.options.map((option) => `「${option.value}」`).join(" / ")} → 建议：${item.suggestion}`));
  }
  if (brief.gaps.length) {
    lines.push(``, `**资料里缺少：**${brief.gaps.map((item) => item.topic).join("、")}。建站时不会编造这些内容，会用已有事实替代或先不做对应区块。`);
  }
  if (brief.risks.length) {
    lines.push(``, `**上线前需要客户确认：**`);
    brief.risks.forEach((item) => lines.push(`- ${item.item}：${item.reason}`));
  }
  lines.push(``, `完整资料卡在 materials/brief.md。确认没问题就回复「开始建站」，冲突按上面的建议处理；也可以直接告诉我哪一条按哪个版本。`);
  return lines.join("\n");
}

export async function readMaterials({ apiKey, projectId, root, emit }: { apiKey: string; projectId: string; root: string; emit: WorkflowEmitter }) {
  enterStage("materials_parse");
  await emit({ type: "stage", stage: "materials", label: "正在解析上传的资料" });
  const index = await ingestMaterialFiles(projectId);
  if (!index.files.length) throw new Error("还没有上传资料");
  const usableImages = index.images.filter((image) => image.grade !== "blank");
  await emit({ type: "stage", stage: "materials", label: `已解析 ${index.files.length} 个文件：文字 ${index.files.reduce((total, file) => total + (file.textChars ?? 0), 0)} 字、图片 ${usableImages.length} 张、整页图 ${index.pages.length} 张，正在看图识别` });
  enterStage("materials_vision");
  const vision: VisionState = { error: "", fatal: false };
  const [notes, pageNotes] = await Promise.all([classifyImages(apiKey, index.images, vision), readPages(apiKey, index, vision)]);
  enterStage("materials_extract");
  await emit({ type: "stage", stage: "materials", label: vision.error ? `看图识别失败（${vision.error.slice(0, 60)}），先按文字整理资料卡` : `看图完成（识别 ${notes.size} 张图片、${index.pages.length} 页），正在整理资料卡` });
  const imageList = [...notes.values()].map((note) => {
    const image = index.images.find((item) => item.id === note.id)!;
    return `- ${note.id}（${KIND_LABELS[note.kind]}，${image.width}×${image.height}，${image.from}）：${note.subject}${note.text ? `；图中文字：${note.text}` : ""}${note.usable ? "" : `；不适合使用：${note.note}`}`;
  }).join("\n");
  const sources = index.files.map((file) => `## 文件：${file.name}（${file.type}）\n${file.error ? `未能读取：${file.error}` : (file.text ?? "").slice(0, 24000)}`).join("\n\n");
  const raw = await requestJson(apiKey, [
    { role: "system", content: extractPrompt },
    { role: "user", content: `# 资料文字\n${sources}\n\n# 看图补充（整页图里的表格、证书、logo 等）\n${pageNotes || (vision.error ? "（看图识别没有完成，这部分信息暂缺。这是系统问题，不要把它写成客户的风险或要求客户重新提供资料）" : "无")}\n\n# 资料图片\n${imageList || "无"}` },
  ], "materials_extract");
  const brief = normalizeBrief(raw, index.images, notes);
  await mkdir(path.join(root, "materials", "sources"), { recursive: true });
  await writeFile(path.join(root, BRIEF_FILE), renderBrief(brief, index.files), "utf8");
  await writeFile(path.join(root, BRIEF_JSON), JSON.stringify(brief, null, 2), "utf8");
  // 原文也存一份，Agent 需要细节时可以 read_file / search_code
  for (const file of index.files) {
    if (file.text) await writeFile(path.join(root, "materials", "sources", `${file.name.replace(/[^\w一-龥.-]+/g, "_")}.md`), file.text, "utf8");
  }
  if (pageNotes) await writeFile(path.join(root, "materials", "sources", "看图补充.md"), pageNotes, "utf8");
  return { brief, reply: renderCard(brief, index, { ...vision, images: index.images.filter((image) => image.grade !== "blank").length, pages: index.pages.length }) };
}
