import type { ReactNode } from "react";
import Container from "./Container";

export default function Section({ eyebrow, title, children }: { eyebrow?: string; title?: string; children: ReactNode }) {
  return <section className="section"><Container>{eyebrow && <p className="eyebrow">{eyebrow}</p>}{title && <h2 className="section-title">{title}</h2>}{children}</Container></section>;
}
