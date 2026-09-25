import { Link } from "../../app/router";
import { siteManifest } from "../../app/site-manifest";
import Container from "../ui/Container";

export default function Footer() {
  return <footer className="site-footer"><Container><div className="site-footer__grid"><div><p className="brand brand--footer"><span className="brand__mark">✦</span>{siteManifest.brand}</p><p className="site-footer__note">页脚内容会在全站基础阶段替换为真实的品牌信息。</p></div><div className="site-footer__links">{siteManifest.routes.filter((route) => route.path !== "/").map((route) => <Link key={route.path} to={route.path}>{route.label}</Link>)}</div></div><div className="site-footer__bottom">© 2026 {siteManifest.brand}</div></Container></footer>;
}
