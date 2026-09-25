import { ActionLink } from "./Actions";
import Reveal from "./Reveal";
import SectionHeader, { BlockShell } from "./SectionHeader";
import type { BlockAction, BlockTone, SectionIntro } from "./types";

type Plan = { name: string; price: string; period?: string; description?: string; features: string[]; highlight?: boolean; badge?: string; action?: BlockAction };

/** 价格方案或套餐对比，highlight 的方案会被放大突出 */
export default function Pricing({ intro, plans, note, tone = "light" }: { intro?: SectionIntro; plans: Plan[]; note?: string; tone?: BlockTone }) {
  return (
    <BlockShell tone={tone} className="blk-pricing">
      <SectionHeader {...intro} align={intro?.align ?? "center"} />
      <div className={`blk-pricing__grid blk-cols-${Math.min(plans.length, 4)}`}>
        {plans.map((plan, index) => (
          <Reveal key={plan.name} delay={index * 70}>
            <article className={`blk-card blk-plan${plan.highlight ? " blk-plan--highlight" : ""}`}>
              {plan.badge && <span className="blk-badge">{plan.badge}</span>}
              <h3 className="blk-card__title">{plan.name}</h3>
              <p className="blk-plan__price">{plan.price}{plan.period && <small>{plan.period}</small>}</p>
              {plan.description && <p className="blk-card__text">{plan.description}</p>}
              <ul className="blk-checklist">{plan.features.map((feature) => <li key={feature}>{feature}</li>)}</ul>
              {plan.action && <ActionLink action={{ variant: plan.highlight ? "primary" : "secondary", ...plan.action }} />}
            </article>
          </Reveal>
        ))}
      </div>
      {note && <p className="blk-note">{note}</p>}
    </BlockShell>
  );
}
