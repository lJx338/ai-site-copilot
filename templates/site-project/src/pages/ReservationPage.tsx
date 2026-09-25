import Button from "../components/ui/Button";
import PageHero from "../components/site/PageHero";
import Section from "../components/ui/Section";

export default function ReservationPage() { return <><PageHero eyebrow="RESERVATION" title="留一张属于你的桌子" description="预约流程使用统一表单样式，后续可以接入数据库和验证码服务。" /><Section title="预约信息"><form className="reservation-form"><label>选择门店<select defaultValue=""><option value="" disabled>请选择门店</option><option>安福路店</option><option>东山口店</option></select></label><label>预约人数<input placeholder="例如：2" /></label><label>备注<textarea placeholder="靠窗座位、商务会面等"></textarea></label><Button type="submit">提交预约</Button></form></Section></>; }
