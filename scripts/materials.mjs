// 用户上传资料的解析：把表格、PDF、Word、图片转成文字和可用图片。只用代码，不调用模型。
// 模型需要的看图（识别 logo、证书、图片里的表格）和提炼资料卡在 lib/agent-workflow.ts 里做。
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { strFromU8, unzipSync } from "fflate";
import sharp from "sharp";

const MIN_IMAGE_SIDE = 120;
const decodeXml = (value) => value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code))).replace(/&amp;/g, "&");

// ---- 表格（.xlsx）：逐行转成“列=值”文字；嵌入的图片按所在单元格记录位置 ----
function columnIndex(ref) {
  let index = 0;
  for (const char of ref.replace(/\d+/g, "")) index = index * 26 + char.charCodeAt(0) - 64;
  return index - 1;
}

// EMF 里通常只包着一张位图（EMR_STRETCHDIBITS，记录类型 81），取出来转成普通图片
async function emfToPng(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  for (let offset = 0; offset + 8 <= buffer.length;) {
    const type = view.getUint32(offset, true);
    const size = view.getUint32(offset + 4, true);
    if (size < 8) break;
    if (type === 81) {
      const offBmi = view.getUint32(offset + 48, true), offBits = view.getUint32(offset + 56, true), cbBits = view.getUint32(offset + 60, true);
      const bmi = offset + offBmi;
      const width = view.getInt32(bmi + 4, true), height = view.getInt32(bmi + 8, true), bpp = view.getUint16(bmi + 14, true);
      if (bpp !== 24 && bpp !== 32) return null;
      const stride = Math.floor((width * bpp + 31) / 32) * 4, bytes = bpp / 8, rows = Math.abs(height);
      const raw = Buffer.alloc(width * rows * 3);
      const bits = buffer.subarray(offset + offBits, offset + offBits + cbBits);
      for (let y = 0; y < rows; y += 1) {
        const source = (height > 0 ? rows - 1 - y : y) * stride;
        for (let x = 0; x < width; x += 1) {
          const at = source + x * bytes, to = (y * width + x) * 3;
          raw[to] = bits[at + 2]; raw[to + 1] = bits[at + 1]; raw[to + 2] = bits[at];
        }
      }
      return sharp(raw, { raw: { width, height: rows, channels: 3 } }).png().toBuffer();
    }
    offset += size;
  }
  return null;
}

async function parseXlsx(buffer) {
  const zip = unzipSync(new Uint8Array(buffer));
  const text = (name) => (zip[name] ? strFromU8(zip[name]) : "");
  const shared = [...text("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((match) => decodeXml([...match[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((item) => item[1]).join("")));
  const sheetNames = [...text("xl/workbook.xml").matchAll(/<sheet [^>]*name="([^"]+)"/g)].map((match) => decodeXml(match[1]));
  const lines = [];
  sheetNames.forEach((sheetName, index) => {
    const xml = text(`xl/worksheets/sheet${index + 1}.xml`);
    if (!xml) return;
    lines.push(`## 工作表：${sheetName}`);
    for (const row of xml.matchAll(/<row [^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const cell of row[2].matchAll(/<c r="([A-Z]+\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const [, ref, attrs, inner = ""] = cell;
        const valueMatch = inner.match(/<v>([\s\S]*?)<\/v>/);
        let value = "";
        if (/t="s"/.test(attrs) && valueMatch) value = shared[Number(valueMatch[1])] ?? "";
        else if (/t="inlineStr"/.test(attrs)) value = decodeXml([...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((item) => item[1]).join(""));
        else if (valueMatch) value = decodeXml(valueMatch[1]);
        if (value.trim()) cells.push({ ref, column: columnIndex(ref), value: value.trim() });
      }
      if (cells.length) lines.push(`- 第 ${row[1]} 行：${cells.map((cell) => `[${cell.ref}] ${cell.value}`).join("　")}`);
    }
  });
  // 嵌入图片：drawing 里记录每张图锚定的单元格，rels 把图片 ID 对应到 xl/media 里的文件
  const images = [];
  for (const drawing of Object.keys(zip).filter((name) => /^xl\/drawings\/drawing\d+\.xml$/.test(name))) {
    const rels = Object.fromEntries([...text(drawing.replace("drawings/", "drawings/_rels/") + ".rels").matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map((match) => [match[1], path.posix.normalize(path.posix.join("xl/drawings", match[2]))]));
    for (const anchor of text(drawing).matchAll(/<xdr:(?:twoCellAnchor|oneCellAnchor)[\s\S]*?<\/xdr:(?:twoCellAnchor|oneCellAnchor)>/g)) {
      const col = anchor[0].match(/<xdr:col>(\d+)<\/xdr:col>/), row = anchor[0].match(/<xdr:row>(\d+)<\/xdr:row>/), embed = anchor[0].match(/r:embed="([^"]+)"/);
      const media = embed && rels[embed[1]];
      if (!media || !zip[media]) continue;
      const cell = col && row ? `${String.fromCharCode(65 + Number(col[1]))}${Number(row[1]) + 1}` : "";
      let data = Buffer.from(zip[media]);
      if (/\.emf$/i.test(media)) data = await emfToPng(data);
      if (data) images.push({ data, from: `嵌入图片，位于单元格 ${cell}（第 ${cell.replace(/\D/g, "")} 行）` });
    }
  }
  return { text: lines.join("\n"), images, pages: [] };
}

// ---- Word（.docx）：按段落取文字，标题保留层级 ----
function parseDocx(buffer) {
  const zip = unzipSync(new Uint8Array(buffer));
  const xml = zip["word/document.xml"] ? strFromU8(zip["word/document.xml"]) : "";
  const paragraphs = [...xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map((match) => {
    const content = decodeXml([...match[0].matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((item) => item[1]).join(""));
    const heading = match[0].match(/<w:pStyle w:val="(?:Heading|标题)\s*(\d)"/i);
    return content.trim() ? `${heading ? "#".repeat(Number(heading[1]) + 1) + " " : ""}${content.trim()}` : "";
  }).filter(Boolean);
  const images = Object.keys(zip).filter((name) => /^word\/media\/.+\.(png|jpe?g|gif|webp)$/i.test(name)).map((name) => ({ data: Buffer.from(zip[name]), from: `文档内嵌图片 ${path.basename(name)}` }));
  return { text: paragraphs.join("\n\n"), images, pages: [] };
}

// ---- PDF：逐页取文字、渲染整页图（给看图模型读图片里的信息），并取出嵌入的照片 ----
async function parsePdf(buffer) {
  const { getDocument, OPS } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({ data: new Uint8Array(buffer), isOffscreenCanvasSupported: false, verbosity: 0 });
  const doc = await task.promise;
  const pageTexts = [], pages = [], images = [];
  for (let number = 1; number <= doc.numPages; number += 1) {
    const page = await doc.getPage(number);
    const content = await page.getTextContent();
    let line = "", out = [];
    for (const item of content.items) {
      line += item.str;
      if (item.hasEOL) { if (line.trim()) out.push(line.trim()); line = ""; }
    }
    if (line.trim()) out.push(line.trim());
    pageTexts.push(`## 第 ${number} 页\n${out.join("\n")}`);
    // 整页图给看图模型读表格和证书：字太小会读错（1400px 宽的跨页画册把 FPC 读成 FR4），
    // 所以按每半页约 1400px 的分辨率渲染；横版跨页切成左右两半分别识别。
    const base = page.getViewport({ scale: 1 });
    const spread = base.width > base.height * 1.2;
    const viewport = page.getViewport({ scale: (spread ? 2800 : 1600) / base.width });
    const canvas = doc.canvasFactory.create(Math.round(viewport.width), Math.round(viewport.height));
    await page.render({ canvasContext: canvas.context, viewport }).promise;
    const rendered = await sharp(canvas.canvas.toBuffer("image/png")).flatten({ background: "#ffffff" }).jpeg({ quality: 82 }).toBuffer();
    const textChars = out.join("").length;
    if (spread) {
      const { width, height } = await sharp(rendered).metadata();
      const half = Math.floor(width / 2);
      for (const [label, left] of [["左半", 0], ["右半", half]]) pages.push({ page: number, part: label, data: await sharp(rendered).extract({ left, top: 0, width: half, height }).jpeg({ quality: 82 }).toBuffer(), textChars });
    } else pages.push({ page: number, data: rendered, textChars });
    // 嵌入照片：遍历绘图指令里的图片对象
    const ops = await page.getOperatorList();
    const seen = new Set();
    for (let i = 0; i < ops.fnArray.length; i += 1) {
      if (ops.fnArray[i] !== OPS.paintImageXObject) continue;
      const id = ops.argsArray[i][0];
      if (seen.has(id)) continue;
      seen.add(id);
      const image = await new Promise((resolve) => { try { (id.startsWith("g_") ? page.commonObjs : page.objs).get(id, resolve); } catch { resolve(null); } });
      if (!image?.data || !image.width || !image.height) continue;
      const channels = image.kind === 3 ? 4 : image.kind === 2 ? 3 : 0;
      if (!channels) continue;
      const data = await sharp(Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength), { raw: { width: image.width, height: image.height, channels } }).flatten({ background: "#ffffff" }).jpeg({ quality: 88 }).toBuffer();
      images.push({ data, from: `第 ${number} 页的嵌入图片` });
    }
    page.cleanup();
  }
  await task.destroy();
  return { text: pageTexts.join("\n\n"), images, pages };
}

// 图片分级：尺寸、是否几乎单色（蒙版、底纹），用于决定能不能用、能用在多大的位置
async function describeImage(data) {
  const image = sharp(data).rotate();
  const meta = await image.metadata();
  const width = meta.autoOrient?.width ?? meta.width ?? 0, height = meta.autoOrient?.height ?? meta.height ?? 0;
  const stats = await image.clone().stats().catch(() => null);
  const spread = stats ? stats.channels.slice(0, 3).reduce((total, channel) => total + channel.stdev, 0) / Math.min(3, stats.channels.length) : 50;
  // logo 往往又宽又矮，按长边判断是否过小
  const grade = spread < 10 ? "blank" : Math.max(width, height) < MIN_IMAGE_SIDE * 1.5 ? "tiny" : width >= 1200 && height >= 700 ? "large" : width >= 640 ? "medium" : "small";
  return { width, height, grade };
}

export function materialsDir(base, projectId) {
  return path.join(base, String(projectId || "default").replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64) || "default");
}

export async function saveOriginal(dir, name, buffer) {
  const safe = path.basename(String(name)).replace(/[\\/:*?"<>|]/g, "_").slice(0, 120) || "file";
  await mkdir(path.join(dir, "originals"), { recursive: true });
  await writeFile(path.join(dir, "originals", safe), buffer);
  return safe;
}

// 解析目录里的全部原始文件。图片统一转成 sRGB JPEG（CMYK 照片直接读会发色异常），
// 按内容去重，几乎单色和过小的图标记出来，不删，由提炼阶段决定是否使用。
export async function ingestMaterials(dir) {
  const originals = await readdir(path.join(dir, "originals")).catch(() => []);
  await mkdir(path.join(dir, "images"), { recursive: true });
  await mkdir(path.join(dir, "pages"), { recursive: true });
  const files = [], images = [], pages = [];
  const seen = new Map();
  for (const name of originals.sort()) {
    const buffer = await readFile(path.join(dir, "originals", name));
    const ext = path.extname(name).toLowerCase();
    let parsed = { text: "", images: [], pages: [] };
    try {
      if (ext === ".xlsx") parsed = await parseXlsx(buffer);
      else if (ext === ".docx") parsed = parseDocx(buffer);
      else if (ext === ".pdf") parsed = await parsePdf(buffer);
      else if ([".md", ".txt", ".csv"].includes(ext)) parsed = { text: buffer.toString("utf8"), images: [], pages: [] };
      else if ([".png", ".jpg", ".jpeg", ".webp", ".gif", ".heic", ".tif", ".tiff"].includes(ext)) parsed = { text: "", images: [{ data: buffer, from: "单独上传的图片" }], pages: [] };
      else { files.push({ name, type: ext.slice(1) || "unknown", error: "暂不支持这种文件类型" }); continue; }
    } catch (error) {
      files.push({ name, type: ext.slice(1), error: error instanceof Error ? error.message.slice(0, 200) : String(error) });
      continue;
    }
    const entry = { name, type: ext.slice(1), textChars: parsed.text.length, images: 0, pages: parsed.pages.length };
    for (const page of parsed.pages) {
      const id = `p${pages.length + 1}`;
      await writeFile(path.join(dir, "pages", `${id}.jpg`), page.data);
      pages.push({ id, file: `pages/${id}.jpg`, from: `${name} 第 ${page.page} 页${page.part ? `（${page.part}）` : ""}`, textChars: page.textChars });
    }
    for (const image of parsed.images) {
      let jpeg;
      try { jpeg = await sharp(image.data).rotate().toColourspace("srgb").flatten({ background: "#ffffff" }).jpeg({ quality: 88 }).toBuffer(); } catch { continue; }
      const hash = createHash("sha1").update(jpeg).digest("hex").slice(0, 12);
      if (seen.has(hash)) continue;
      const info = await describeImage(jpeg);
      const id = `m${images.length + 1}`;
      seen.set(hash, id);
      await writeFile(path.join(dir, "images", `${id}.jpg`), jpeg);
      images.push({ id, file: `images/${id}.jpg`, from: `${name}：${image.from}`, ...info });
      entry.images += 1;
    }
    files.push({ ...entry, text: parsed.text });
  }
  const index = { updatedAt: new Date().toISOString(), files, images, pages };
  await writeFile(path.join(dir, "index.json"), JSON.stringify(index, null, 2));
  return index;
}
