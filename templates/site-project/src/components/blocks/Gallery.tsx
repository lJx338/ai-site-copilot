import SiteImage from "../ui/SiteImage";
import Reveal from "./Reveal";
import SectionHeader, { BlockShell } from "./SectionHeader";
import type { BlockImage, BlockTone, SectionIntro } from "./types";

/** 图片画廊：grid 等大网格；mosaic 首图放大的拼贴（3 张或 5 张最整齐），适合空间、作品、案例 */
export default function Gallery({ intro, items, variant = "mosaic", tone = "light" }: { intro?: SectionIntro; items: Array<BlockImage & { caption?: string }>; variant?: "grid" | "mosaic"; tone?: BlockTone }) {
  return (
    <BlockShell tone={tone} className={`blk-gallery blk-gallery--${variant}${variant === "mosaic" && items.length === 5 ? " blk-gallery--m5" : ""}`}>
      <SectionHeader {...intro} />
      <div className="blk-gallery__grid">
        {items.map((item, index) => (
          <Reveal key={item.slot} delay={Math.min(index, 5) * 60} className={variant === "mosaic" && index === 0 ? "blk-gallery__feature" : ""}>
            <figure className="blk-gallery__item">
              <SiteImage {...item} ratio={variant === "mosaic" && index === 0 ? "fill" : item.ratio ?? "4:3"} className="blk-radius" />
              {item.caption && <figcaption>{item.caption}</figcaption>}
            </figure>
          </Reveal>
        ))}
      </div>
    </BlockShell>
  );
}
