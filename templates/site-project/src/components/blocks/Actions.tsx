import { Link } from "../../app/router";
import type { BlockAction } from "./types";

export function ActionLink({ action }: { action: BlockAction }) {
  const className = `blk-btn blk-btn--${action.variant ?? "primary"}`;
  if (action.to) return <Link className={className} to={action.to}>{action.label}</Link>;
  return <a className={className} href={action.href ?? "#"} {...(action.href?.startsWith("http") ? { target: "_blank", rel: "noreferrer" } : {})}>{action.label}</a>;
}

export default function Actions({ actions, className = "" }: { actions?: BlockAction[]; className?: string }) {
  if (!actions?.length) return null;
  return <div className={`blk-actions ${className}`}>{actions.map((action) => <ActionLink key={action.label} action={action} />)}</div>;
}
