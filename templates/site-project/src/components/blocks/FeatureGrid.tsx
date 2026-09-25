import type { ReactNode } from "react";
import SiteImage from "../ui/SiteImage";
import { ActionLink } from "./Actions";
import Reveal from "./Reveal";
import SectionHeader, { BlockShell } from "./SectionHeader";
import type { BlockAction, BlockImage, BlockTone, SectionIntro } from "./types";

type Feature = { title: string; description: string; icon?: ReactNode; image?: BlockImage; meta?: string; action?: BlockAction };

/**
 * cards：带图卡片网格；icons：图标加文字，信息密度高；
 * bento：第一项占大格，其余小格，适合突出一个核心卖点
 */
export default function FeatureGrid({ intro, items, variant = "cards", columns = 3, tone = "light" }: { intro?: SectionIntro; items: Feature[]; variant?: "cards" | "icons" | "bento"; columns?: 2 | 3 | 4; tone?: BlockTone }) {
  return (
    <BlockShell tone={tone} className={`blk-features blk-features--${variant}`}>
      <SectionHeader {...intro} />
      <div className={`blk-features__grid blk-cols-${columns}`}>
        {items.map((item, index) => (
          <Reveal key={item.title} delay={Math.min(index, 5) * 60} className={variant === "bento" && index === 0 ? "blk-features__hero-cell" : ""}>
            <article className="blk-card blk-feature">
              {item.image && variant !== "icons" && <SiteImage {...item.image} ratio={item.image.ratio ?? (variant === "bento" && index === 0 ? "16:9" : "3:2")} className="blk-feature__image" />}
              <div className="blk-feature__body">
                {item.icon && <span className="blk-feature__icon" aria-hidden="true">{item.icon}</span>}
                {item.meta && <p className="blk-meta">{item.meta}</p>}
                <h3 className="blk-card__title">{item.title}</h3>
                <p className="blk-card__text">{item.description}</p>
                {item.action && <ActionLink action={{ variant: "link", ...item.action }} />}
              </div>
            </article>
          </Reveal>
        ))}
      </div>
    </BlockShell>
  );
}
