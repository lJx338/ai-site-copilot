import Container from "../ui/Container";

export default function PageHero({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return <section className="page-hero"><Container><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="page-hero__description">{description}</p></Container></section>;
}
