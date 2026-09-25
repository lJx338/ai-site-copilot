import { Menu, X } from "lucide-react";
import { useState } from "react";
import { NavLink } from "../../app/router";
import { siteManifest } from "../../app/site-manifest";
import Button from "../ui/Button";

// 导航和主按钮都来自 site-manifest.ts，路由变化时不会出现死链。
const navRoutes = siteManifest.routes.filter((route) => route.path !== "/");
const ctaRoute = navRoutes.at(-1);

export default function Header() {
  const [open, setOpen] = useState(false);
  return <header className="site-header"><div className="container site-header__inner"><NavLink className="brand" to="/"><span className="brand__mark">✦</span><span>{siteManifest.brand}</span></NavLink><nav className={`site-nav ${open ? "site-nav--open" : ""}`}>{navRoutes.filter((route) => route !== ctaRoute).map((route) => <NavLink key={route.path} onClick={() => setOpen(false)} className={({ isActive }) => isActive ? "site-nav__link is-active" : "site-nav__link"} to={route.path}>{route.label}</NavLink>)}{ctaRoute && <Button to={ctaRoute.path}>{ctaRoute.label}</Button>}</nav><button className="menu-toggle" aria-label={open ? "关闭菜单" : "打开菜单"} aria-expanded={open} onClick={() => setOpen((value) => !value)}>{open ? <X /> : <Menu />}</button></div></header>;
}
