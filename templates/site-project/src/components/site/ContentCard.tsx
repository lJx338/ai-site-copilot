import type { ReactNode } from "react";

export default function ContentCard({ title, description, meta, children }: { title: string; description: string; meta?: string; children?: ReactNode }) {
  return <article className="content-card">{children && <div className="content-card__media">{children}</div>}<div className="content-card__body">{meta && <p className="content-card__meta">{meta}</p>}<h3>{title}</h3><p>{description}</p></div></article>;
}
