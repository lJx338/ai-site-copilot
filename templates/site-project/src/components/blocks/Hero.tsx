import SiteImage from "../ui/SiteImage";
import Actions from "./Actions";
import Reveal from "./Reveal";
import type { BlockAction, BlockImage, BlockTone } from "./types";

type HeroProps = {
  /** split：左文右图；overlay：满屏大图加蒙版文字；centered：居中文字加下方宽图 */
  variant?: "split" | "overlay" | "centered";
  tone?: BlockTone;
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: BlockAction[];
  image: BlockImage;
  /** 首屏下方的 2–4 个关键数字 */
  stats?: Array<{ value: string; label: string }>;
  /** 按钮下方的小字说明，例如服务承诺 */
  note?: string;
};

export default function Hero({ variant = "split", tone = "light", eyebrow, title, description, actions, image, stats, note }: HeroProps) {
  const text = (
    <div className="blk-hero__text">
      {eyebrow && <p className="blk-eyebrow">{eyebrow}</p>}
      <h1 className="blk-hero__title">{title}</h1>
      {description && <p className="blk-hero__lead">{description}</p>}
      <Actions actions={actions} />
      {note && <p className="blk-hero__note">{note}</p>}
    </div>
  );
  const statsRow = stats?.length ? (
    <dl className="blk-hero__stats">
      {stats.map((stat) => <div key={stat.label}><dt>{stat.value}</dt><dd>{stat.label}</dd></div>)}
    </dl>
  ) : null;

  if (variant === "overlay") {
    return (
      <section className="blk-hero blk-hero--overlay">
        <SiteImage {...image} ratio="fill" priority className="blk-hero__bg" />
        <div className="blk-hero__scrim" />
        <div className="blk__inner blk-hero__overlay-inner">
          <Reveal>{text}</Reveal>
          {statsRow}
        </div>
      </section>
    );
  }

  return (
    <section className={`blk blk--${tone} blk-hero blk-hero--${variant}`}>
      <div className="blk__inner">
        <div className="blk-hero__grid">
          <Reveal>{text}</Reveal>
          <Reveal delay={120} className="blk-hero__media">
            <SiteImage {...image} ratio={image.ratio ?? (variant === "centered" ? "21:9" : "4:3")} priority className="blk-radius" />
          </Reveal>
        </div>
        {statsRow}
      </div>
    </section>
  );
}
