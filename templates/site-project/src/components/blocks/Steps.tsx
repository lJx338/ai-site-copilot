import Reveal from "./Reveal";
import SectionHeader, { BlockShell } from "./SectionHeader";
import type { BlockTone, SectionIntro } from "./types";

/** 流程或时间线：steps 横向编号步骤（手机上自动纵向）；timeline 纵向时间轴，适合品牌历程 */
export default function Steps({ intro, items, variant = "steps", tone = "light" }: { intro?: SectionIntro; items: Array<{ title: string; description: string; meta?: string }>; variant?: "steps" | "timeline"; tone?: BlockTone }) {
  return (
    <BlockShell tone={tone} className={`blk-steps blk-steps--${variant}`}>
      <SectionHeader {...intro} />
      <ol className="blk-steps__list">
        {items.map((item, index) => (
          <li key={item.title} className="blk-steps__item">
            <Reveal delay={Math.min(index, 5) * 70}>
              <span className="blk-steps__marker">{variant === "timeline" ? item.meta ?? String(index + 1) : String(index + 1).padStart(2, "0")}</span>
              <h3 className="blk-card__title">{item.title}</h3>
              <p className="blk-card__text">{item.description}</p>
              {variant === "steps" && item.meta && <p className="blk-meta">{item.meta}</p>}
            </Reveal>
          </li>
        ))}
      </ol>
    </BlockShell>
  );
}
