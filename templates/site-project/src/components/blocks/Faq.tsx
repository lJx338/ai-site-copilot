import SectionHeader, { BlockShell } from "./SectionHeader";
import type { BlockTone, SectionIntro } from "./types";

/** 常见问题手风琴（原生 details，不需要脚本，键盘可用） */
export default function Faq({ intro, items, tone = "light" }: { intro?: SectionIntro; items: Array<{ question: string; answer: string }>; tone?: BlockTone }) {
  return (
    <BlockShell tone={tone} className="blk-faq">
      <div className="blk-faq__layout">
        <SectionHeader {...intro} />
        <div className="blk-faq__list">
          {items.map((item, index) => (
            <details key={item.question} className="blk-faq__item" open={index === 0}>
              <summary>{item.question}</summary>
              <p>{item.answer}</p>
            </details>
          ))}
        </div>
      </div>
    </BlockShell>
  );
}
