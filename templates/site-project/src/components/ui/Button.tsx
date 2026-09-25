import type { ReactNode } from "react";
import { Link } from "../../app/router";

type ButtonProps = { children: ReactNode; to?: string; variant?: "primary" | "secondary"; type?: "button" | "submit" };

export default function Button({ children, to, variant = "primary", type = "button" }: ButtonProps) {
  const className = `button button--${variant}`;
  return to ? <Link className={className} to={to}>{children}</Link> : <button className={className} type={type}>{children}</button>;
}
