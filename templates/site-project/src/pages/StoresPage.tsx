import ContentCard from "../components/site/ContentCard";
import PageHero from "../components/site/PageHero";
import Section from "../components/ui/Section";

const stores = ["安福路店", "东山口店", "滨江店"];
export default function StoresPage() { return <><PageHero eyebrow="FIND A STORE" title="在城市里找到你的座位" description="每个门店都复用同一张卡片和信息层级，新增门店不会改变页面结构。" /><Section title="门店信息"><div className="card-grid card-grid--three">{stores.map((store) => <ContentCard key={store} title={store} description="地址、营业时间和预约状态将在这里展示。"><div className="media-placeholder media-placeholder--warm">STORE</div></ContentCard>)}</div></Section></>; }
