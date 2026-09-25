import "../../styles/blocks.css";
import type { ReactNode } from "react";
import { ActionLink } from "./Actions";
import type { SectionIntro } from "./types";

export default function SectionHeader({ eyebrow, title, description, align = "left", action }: SectionIntro) {
  if (!eyebrow && !title && !description) return null;
  return (
    <header className={`blk-head blk-head--${align}`}>
      <div className="blk-head__text">
        {eyebrow && <p className="blk-eyebrow">{eyebrow}</p>}
        {title && <h2 className="blk-title">{title}</h2>}
        {description && <p className="blk-lead">{description}</p>}
      </div>
      {action && <ActionLink action={{ variant: "link", ...action }} />}
    </header>
  );
}

export function BlockShell({ tone = "light", id, className = "", children }: { tone?: "light" | "muted" | "dark"; id?: string; className?: string; children: ReactNode }) {
  return <section id={id} className={`blk blk--${tone} ${className}`}><div className="blk__inner">{children}</div></section>;
}
