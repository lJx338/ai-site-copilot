import SiteImage from "../ui/SiteImage";
import Reveal from "./Reveal";
import SectionHeader, { BlockShell } from "./SectionHeader";
import type { BlockImage, BlockTone, SectionIntro } from "./types";

type Testimonial = { quote: string; name: string; role?: string; company?: string; avatar?: BlockImage };

/** 客户评价：grid 多条并列；featured 第一条放大突出，其余并列 */
export default function Testimonials({ intro, items, variant = "grid", tone = "muted" }: { intro?: SectionIntro; items: Testimonial[]; variant?: "grid" | "featured"; tone?: BlockTone }) {
  return (
    <BlockShell tone={tone} className={`blk-quotes blk-quotes--${variant}`}>
      <SectionHeader {...intro} />
      <div className="blk-quotes__grid">
        {items.map((item, index) => (
          <Reveal key={item.name + index} delay={Math.min(index, 5) * 60} className={variant === "featured" && index === 0 ? "blk-quotes__featured" : ""}>
            <figure className="blk-card blk-quote">
              <blockquote>“{item.quote}”</blockquote>
              <figcaption>
                {item.avatar && <SiteImage {...item.avatar} kind="portrait" ratio="1:1" className="blk-quote__avatar" />}
                <span><b>{item.name}</b>{(item.role || item.company) && <small>{[item.role, item.company].filter(Boolean).join(" · ")}</small>}</span>
              </figcaption>
            </figure>
          </Reveal>
        ))}
      </div>
    </BlockShell>
  );
}
