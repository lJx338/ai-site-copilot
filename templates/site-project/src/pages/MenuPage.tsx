import ContentCard from "../components/site/ContentCard";
import PageHero from "../components/site/PageHero";
import Section from "../components/ui/Section";

const products = ["手冲单品", "桂花拿铁", "海盐冷萃", "燕麦摩卡", "柚子气泡美式", "季节甜点"];
export default function MenuPage() { return <><PageHero eyebrow="THE MENU" title="今天想喝哪一杯？" description="页面内容可以替换，布局和视觉由共享组件保持一致。" /><Section title="本周菜单"><div className="card-grid card-grid--three">{products.map((product, index) => <ContentCard key={product} meta={`0${index + 1}`} title={product} description="一段简洁的产品描述，等待真实内容接入。"><div className="media-placeholder">MENU</div></ContentCard>)}</div></Section></>; }
