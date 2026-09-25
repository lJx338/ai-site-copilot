import { useState, type FormEvent } from "react";
import SectionHeader, { BlockShell } from "./SectionHeader";
import type { BlockTone, SectionIntro } from "./types";

type Field = { name: string; label: string; type?: "text" | "email" | "tel" | "textarea" | "select"; required?: boolean; options?: string[]; placeholder?: string };

/**
 * 联系方式加留言表单。表单只在浏览器里校验并显示成功状态（原型阶段没有后端）。
 * channels 例如 { label: "电话", value: "400-820-6633", href: "tel:4008206633" }
 */
export default function ContactBlock({ intro, channels, fields, submitLabel = "提交", successMessage = "已收到，我们会尽快联系你。", tone = "muted" }: { intro?: SectionIntro; channels: Array<{ label: string; value: string; href?: string; note?: string }>; fields: Field[]; submitLabel?: string; successMessage?: string; tone?: BlockTone }) {
  const [sent, setSent] = useState(false);
  const [errors, setErrors] = useState<Record<string, boolean>>({});
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const next = Object.fromEntries(fields.filter((field) => field.required && !String(data.get(field.name) ?? "").trim()).map((field) => [field.name, true]));
    setErrors(next);
    if (!Object.keys(next).length) setSent(true);
  };
  return (
    <BlockShell tone={tone} className="blk-contact">
      <div className="blk-contact__layout">
        <div>
          <SectionHeader {...intro} />
          <ul className="blk-contact__channels">
            {channels.map((channel) => (
              <li key={channel.label}>
                <span>{channel.label}</span>
                {channel.href ? <a href={channel.href}>{channel.value}</a> : <b>{channel.value}</b>}
                {channel.note && <small>{channel.note}</small>}
              </li>
            ))}
          </ul>
        </div>
        <div className="blk-card blk-contact__form">
          {sent ? (
            <p className="blk-contact__success" role="status">{successMessage}</p>
          ) : (
            <form noValidate onSubmit={submit}>
              {fields.map((field) => (
                <label key={field.name} className={`blk-field${errors[field.name] ? " blk-field--error" : ""}`}>
                  <span>{field.label}{field.required && <em aria-hidden="true"> *</em>}</span>
                  {field.type === "textarea" ? <textarea name={field.name} rows={4} placeholder={field.placeholder} required={field.required} />
                    : field.type === "select" ? <select name={field.name} required={field.required} defaultValue=""><option value="" disabled>{field.placeholder ?? "请选择"}</option>{field.options?.map((option) => <option key={option}>{option}</option>)}</select>
                    : <input name={field.name} type={field.type ?? "text"} placeholder={field.placeholder} required={field.required} />}
                  {errors[field.name] && <small role="alert">请填写{field.label}</small>}
                </label>
              ))}
              <button className="blk-btn blk-btn--primary" type="submit">{submitLabel}</button>
            </form>
          )}
        </div>
      </div>
    </BlockShell>
  );
}
