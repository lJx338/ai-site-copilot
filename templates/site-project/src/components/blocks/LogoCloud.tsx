import { BlockShell } from "./SectionHeader";
import type { BlockTone } from "./types";

/** 客户或合作伙伴名称条，用文字 logo 展示信任背书 */
export default function LogoCloud({ title, items, tone = "light" }: { title?: string; items: string[]; tone?: BlockTone }) {
  return (
    <BlockShell tone={tone} className="blk-logos">
      {title && <p className="blk-logos__title">{title}</p>}
      <ul className="blk-logos__list">{items.map((item) => <li key={item}>{item}</li>)}</ul>
    </BlockShell>
  );
}
