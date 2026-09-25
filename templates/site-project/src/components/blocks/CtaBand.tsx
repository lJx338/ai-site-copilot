import SiteImage from "../ui/SiteImage";
import Actions from "./Actions";
import Reveal from "./Reveal";
import type { BlockAction, BlockImage } from "./types";

/** 页尾行动号召横幅。给 image 时是带背景图的深色横幅 */
export default function CtaBand({ eyebrow, title, description, actions, image }: { eyebrow?: string; title: string; description?: string; actions?: BlockAction[]; image?: BlockImage }) {
  return (
    <section className="blk blk-cta">
      <div className="blk__inner">
        <Reveal>
          <div className={`blk-cta__panel${image ? " blk-cta__panel--image" : ""}`}>
            {image && <SiteImage {...image} ratio="fill" className="blk-cta__bg" />}
            <div className="blk-cta__content">
              {eyebrow && <p className="blk-eyebrow">{eyebrow}</p>}
              <h2 className="blk-title">{title}</h2>
              {description && <p className="blk-lead">{description}</p>}
              <Actions actions={actions} />
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
