import PageHero from "../components/site/PageHero";
import Section from "../components/ui/Section";

export default function ContactPage() { return <><PageHero eyebrow="CONTACT" title="和我们聊聊你的计划" description="联系页面继承全站的排版、表单和按钮规范。" /><Section title="联系我们"><div className="contact-grid"><div className="contact-panel"><p className="eyebrow">EMAIL</p><h3>hello@example.com</h3><p>工作日 09:00—18:00 回复。</p></div><div className="contact-panel"><p className="eyebrow">PHONE</p><h3>400 000 2026</h3><p>欢迎咨询网站内容和预约服务。</p></div></div></Section></>; }
