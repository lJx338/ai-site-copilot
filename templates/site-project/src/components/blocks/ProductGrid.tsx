import { Link } from "../../app/router";
import SiteImage from "../ui/SiteImage";
import Reveal from "./Reveal";
import SectionHeader, { BlockShell } from "./SectionHeader";
import type { BlockImage, BlockTone, SectionIntro } from "./types";

type Product = { name: string; tagline?: string; price?: string; badge?: string; specs?: Array<{ label: string; value: string }>; image: BlockImage; to?: string };

/**
 * 带图的产品或服务卡片。card：大图卡片，最多展示 3 条规格；
 * compact：横向小卡，适合 6 个以上的完整列表。超过 9 个同类项目时优先用 compact 或分组。
 */
export default function ProductGrid({ intro, items, variant = "card", columns = 3, tone = "light" }: { intro?: SectionIntro; items: Product[]; variant?: "card" | "compact"; columns?: 2 | 3 | 4; tone?: BlockTone }) {
  return (
    <BlockShell tone={tone} className={`blk-products blk-products--${variant}`}>
      <SectionHeader {...intro} />
      <div className={`blk-products__grid blk-cols-${variant === "compact" ? 2 : columns}`}>
        {items.map((item, index) => {
          const body = (
            <article className="blk-card blk-product">
              <SiteImage {...item.image} kind={item.image.kind ?? "product"} ratio={item.image.ratio ?? (variant === "compact" ? "1:1" : "4:3")} className="blk-product__image" />
              <div className="blk-product__body">
                <div className="blk-product__top">
                  <h3 className="blk-card__title">{item.name}</h3>
                  {item.badge && <span className="blk-badge">{item.badge}</span>}
                </div>
                {item.tagline && <p className="blk-card__text">{item.tagline}</p>}
                {item.specs?.length ? (
                  <dl className="blk-product__specs">
                    {item.specs.slice(0, variant === "compact" ? 2 : 3).map((spec) => <div key={spec.label}><dt>{spec.label}</dt><dd>{spec.value}</dd></div>)}
                  </dl>
                ) : null}
                {item.price && <p className="blk-product__price">{item.price}</p>}
              </div>
            </article>
          );
          return <Reveal key={item.name} delay={Math.min(index, 5) * 60}>{item.to ? <Link className="blk-product__link" to={item.to}>{body}</Link> : body}</Reveal>;
        })}
      </div>
    </BlockShell>
  );
}
