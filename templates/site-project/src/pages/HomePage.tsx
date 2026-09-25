import { ArrowUpRight } from "lucide-react";
import { Link } from "../app/router";
import Button from "../components/ui/Button";
import Container from "../components/ui/Container";
import ContentCard from "../components/site/ContentCard";
import Section from "../components/ui/Section";

export default function HomePage() {
  return <><section className="hero"><Container><p className="eyebrow">A SHARED STARTING POINT</p><h1>把每一页，<em>做成同一个品牌。</em></h1><p className="hero__description">这是一个可持续修改的 AI 网站项目骨架。页面共享布局、组件和设计令牌，后续 Agent 只需修改真实代码。</p><div className="hero__actions"><Button to="/reservation">开始预约</Button><Button to="/menu" variant="secondary">浏览内容</Button></div></Container></section><Section eyebrow="SYSTEM FIRST" title="统一的组件，稳定的页面"><div className="card-grid card-grid--three"><ContentCard meta="01" title="共享导航" description="所有页面使用同一个 Header、路由表和移动端菜单。"><div className="media-placeholder media-placeholder--dark">HEADER</div></ContentCard><ContentCard meta="02" title="设计令牌" description="颜色、间距、圆角和字体集中管理，修改一次全站同步。"><div className="media-placeholder">TOKENS</div></ContentCard><ContentCard meta="03" title="可持续修改" description="Agent 读取已有代码后做局部补丁，避免每轮重新生成整站。"><div className="media-placeholder media-placeholder--accent">PATCH</div></ContentCard></div></Section><Section eyebrow="NEXT STEP" title="从骨架开始，逐页完成"><div className="split-callout"><div><h3>先稳定公共层，再扩展业务页面。</h3><p>菜单、门店、预约和联系页面都已经接入统一路由。你可以直接让 Agent 继续填充真实内容。</p></div><Link to="/contact">查看页面结构 <ArrowUpRight /></Link></div></Section></>;
}
