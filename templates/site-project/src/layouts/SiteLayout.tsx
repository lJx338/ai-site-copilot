import type { ReactNode } from "react";
import Footer from "../components/site/Footer";
import Header from "../components/site/Header";

export default function SiteLayout({ children }: { children: ReactNode }) {
  return (
    <div className="site-shell">
      <Header />
      <main className="site-main">{children}</main>
      <Footer />
    </div>
  );
}
