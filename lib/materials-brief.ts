import { readFile } from "node:fs/promises";
import path from "node:path";

// 客户资料卡：由上传资料提炼（lib/materials.ts），放在项目的 materials/ 目录，随工作区同步。
// 有资料卡时，建站以资料为准；没有时沿用“补全成可信示例内容”的规则。
export const BRIEF_FILE = "materials/brief.md";
export const BRIEF_JSON = "materials/brief.json";

export const materialsPolicy = `资料规则（本项目有客户上传的资料，优先级高于上面的内容规则）：
- 客户资料卡（materials/brief.md）里的事实必须原样使用：公司名、年份、数字、资质、专利、客户、地址、电话、邮箱、产品和工艺参数都不得改写、不得矛盾。
- 资料里没有的内容才可以补充，补充要保守、合理，并逐条记录在 docs/content-todo.md。严禁编造资料中没有的资质、证书、专利、奖项、客户或合作伙伴名称、客户评价、合作案例和具体业绩数字。需要证明实力时，用资料里已有的事实（设备、产能、工艺、资质、流程、合作伙伴）来建立信任；没有客户评价就不做评价区块。
- 资料卡里的冲突：用户在对话中做了决定的按用户的，没说的按资料卡里的建议。
- 图片优先用资料图片：<SiteImage asset="m12" ...>，ID 和"适合的位置"见资料卡的图片清单。小图只放在缩略图、网格小卡这类显示宽度不超过 360px 的位置，不要放大到首屏或整行横幅；logo 用 LogoCloud 的 { name, asset }；证书照片用在资质区块。没有合适资料图片的位置再用图库（不写 asset）。
- 品牌色和品牌名写法以资料卡为准。`;

export async function readBrief(root: string | undefined) {
  if (!root) return "";
  try { return (await readFile(path.join(root, BRIEF_FILE), "utf8")).trim(); } catch { return ""; }
}

// 放进提示词的资料卡；太长时截断（完整内容可以 read_file materials/brief.md）
export function briefSection(brief: string, limit = 24000) {
  if (!brief) return "";
  const body = brief.length > limit ? `${brief.slice(0, limit)}\n\n（资料卡较长，已截断；完整内容见 materials/brief.md）` : brief;
  return `\n\n# 客户资料卡（事实以此为准）\n${body}`;
}
