import Reveal from "./Reveal";
import SectionHeader, { BlockShell } from "./SectionHeader";
import type { BlockTone, SectionIntro } from "./types";

/** 一排关键数字，适合放在首屏之后或深色背景上做节奏变化 */
export default function StatsBand({ intro, items, tone = "dark" }: { intro?: SectionIntro; items: Array<{ value: string; label: string; note?: string }>; tone?: BlockTone }) {
  return (
    <BlockShell tone={tone} className="blk-stats">
      <SectionHeader {...intro} />
      <Reveal>
        <dl className="blk-stats__list">
          {items.map((item) => (
            <div key={item.label} className="blk-stats__item">
              <dt>{item.value}</dt>
              <dd>{item.label}{item.note && <small>{item.note}</small>}</dd>
            </div>
          ))}
        </dl>
      </Reveal>
    </BlockShell>
  );
}
