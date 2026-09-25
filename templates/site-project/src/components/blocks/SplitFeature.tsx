import SiteImage from "../ui/SiteImage";
import Actions from "./Actions";
import Reveal from "./Reveal";
import SectionHeader, { BlockShell } from "./SectionHeader";
import type { BlockAction, BlockImage, BlockTone, SectionIntro } from "./types";

type SplitItem = { eyebrow?: string; title: string; description: string; bullets?: string[]; image: BlockImage; actions?: BlockAction[] };

/** 图文左右交错的段落，适合讲清 2–4 个重点（方案、工艺、服务流程） */
export default function SplitFeature({ intro, items, tone = "light", startImageLeft = false }: { intro?: SectionIntro; items: SplitItem[]; tone?: BlockTone; startImageLeft?: boolean }) {
  return (
    <BlockShell tone={tone} className="blk-split">
      <SectionHeader {...intro} />
      <div className="blk-split__list">
        {items.map((item, index) => {
          const imageLeft = (index % 2 === 0) === startImageLeft;
          return (
            <div key={item.title} className={`blk-split__row${imageLeft ? " blk-split__row--image-left" : ""}`}>
              <Reveal className="blk-split__text">
                {item.eyebrow && <p className="blk-eyebrow">{item.eyebrow}</p>}
                <h3 className="blk-split__title">{item.title}</h3>
                <p className="blk-lead">{item.description}</p>
                {item.bullets?.length ? <ul className="blk-checklist">{item.bullets.map((bullet) => <li key={bullet}>{bullet}</li>)}</ul> : null}
                <Actions actions={item.actions} />
              </Reveal>
              <Reveal className="blk-split__media"><SiteImage {...item.image} ratio={item.image.ratio ?? "4:3"} className="blk-radius" /></Reveal>
            </div>
          );
        })}
      </div>
    </BlockShell>
  );
}
