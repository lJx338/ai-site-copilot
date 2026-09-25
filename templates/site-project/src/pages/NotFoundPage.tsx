import Button from "../components/ui/Button";
import PageHero from "../components/site/PageHero";
import Section from "../components/ui/Section";

export default function NotFoundPage() {
  return <><PageHero eyebrow="404" title="这个页面还没有准备好" description="地址可能已经改变，或者你输入了一个尚未发布的页面。" /><Section title="回到已发布内容"><Button to="/">返回首页</Button></Section></>;
}
