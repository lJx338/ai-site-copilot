import { createContext, useContext, useEffect, useMemo, useState, type AnchorHTMLAttributes, type ReactNode } from "react";

type RouterValue = { path: string; navigate: (to: string) => void };
const RouterContext = createContext<RouterValue | null>(null);

function currentPath() {
  if (typeof window === "undefined") return "/";
  const raw = window.location.hash.replace(/^#/, "").split("?")[0];
  return raw || "/";
}

export function HashRouter({ children }: { children: ReactNode }) {
  const [path, setPath] = useState(currentPath);
  useEffect(() => {
    const onHashChange = () => setPath(currentPath());
    window.addEventListener("hashchange", onHashChange);
    if (!window.location.hash) window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#/`);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  const value = useMemo(() => ({ path, navigate: (to: string) => { window.location.hash = to; } }), [path]);
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export function useRouter() {
  const value = useContext(RouterContext);
  if (!value) throw new Error("useRouter 必须在 HashRouter 内使用");
  return value;
}

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { to: string };
type NavLinkProps = Omit<LinkProps, "className"> & { className?: string | ((state: { isActive: boolean }) => string) };
export function Link({ to, children, onClick, ...props }: LinkProps) {
  return <a href={`#${to}`} onClick={(event) => { onClick?.(event); }} {...props}>{children}</a>;
}

export function NavLink({ to, children, className, onClick, ...props }: NavLinkProps) {
  const { path } = useRouter();
  const resolvedClassName = typeof className === "function" ? className({ isActive: path === to }) : className;
  return <a href={`#${to}`} className={resolvedClassName} onClick={(event) => { onClick?.(event); }} {...props}>{children}</a>;
}
