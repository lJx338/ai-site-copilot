import SiteImage from "../ui/SiteImage";
import { BlockShell } from "./SectionHeader";
import type { BlockTone } from "./types";

/** 客户或合作伙伴 logo 条。items 可以是名称（显示为文字 logo），也可以带资料里的 logo 图片 ID（asset） */
export type LogoItem = string | { name: string; asset?: string };

export default function LogoCloud({ title, items, tone = "light" }: { title?: string; items: LogoItem[]; tone?: BlockTone }) {
  return (
    <BlockShell tone={tone} className="blk-logos">
      {title && <p className="blk-logos__title">{title}</p>}
      <ul className="blk-logos__list">
        {items.map((item) => {
          const { name, asset } = typeof item === "string" ? { name: item, asset: undefined } : item;
          return (
            <li key={name} className={asset ? "blk-logos__item--image" : undefined}>
              {asset ? <SiteImage slot={`logo-${asset}`} kind="logo" asset={asset} query={`${name} logo`} ratio="3:1" alt={name} /> : name}
            </li>
          );
        })}
      </ul>
    </BlockShell>
  );
}
