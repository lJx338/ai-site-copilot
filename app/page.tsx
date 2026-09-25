"use client";

import { useEffect, useState } from "react";
import { ArrowUp, Check, CircleAlert, History, LoaderCircle, Monitor, PanelRight, RefreshCw, Smartphone, Sparkles, WandSparkles } from "lucide-react";

type Message = { role: "assistant" | "user"; text: string; changes?: string[] };
type AgentFile = { path: string; content: string };
type SitePlan = { summary: string; mode: "new_site" | "modify_site"; readOnly?: boolean; prdMarkdown?: string; designMarkdown?: string; assumptions: string[]; questions: string[]; pages: Array<{ name: string; route: string; goal: string; sections: string[] }>; sharedComponents: string[]; filePlan: string[]; acceptanceCriteria: string[] };
type WorkflowEvent = { type: string; label?: string; message?: string; error?: string; round?: number; ok?: boolean; plan?: SitePlan; result?: AgentResult };
type AgentResult = { reply: string; files: AgentFile[]; previewUrl?: string; events: string[]; plan?: SitePlan; check?: { ok: boolean; errors?: string[]; warnings?: string[] }; validation?: { ok: boolean; cached?: boolean; skipped?: boolean; error?: string }; qualityReview?: { ok: boolean; score: number; blockingIssues?: string[]; suggestions?: string[] }; readOnly?: boolean; error?: string };

const projectId = "coffee-studio";
const initialPreviewUrl = `/api/preview?projectId=${projectId}&v=initial`;
const starterPrompts = [
  "从零创建一个精品咖啡馆预约网站",
  "把首页改成更高级的深绿色风格",
  "增加一个会员预约入口",
];

function PlanCard({ plan }: { plan: SitePlan }) {
  return <div className="rounded-2xl border border-[#e8ded4] bg-[#fffaf5] px-4 py-3 text-xs text-[#62584f]"><div className="flex items-center justify-between gap-3"><p className="font-semibold text-[#423a33]">{plan.mode === "new_site" ? "建站计划" : "修改计划"}</p><span className="rounded-full bg-[#f2e4d7] px-2 py-1 text-[10px] text-[#9b6947]">{plan.readOnly ? "只读审计" : "先分析后执行"}</span></div><p className="mt-2 leading-5">{plan.summary}</p>{plan.pages.length > 0 && <div className="mt-3 flex flex-wrap gap-1.5">{plan.pages.map((page) => <span key={`${page.route}-${page.name}`} className="rounded-md border border-[#eadfd4] bg-white px-2 py-1 text-[10px]">{page.name} <span className="text-[#aaa097]">{page.route}</span></span>)}</div>}{plan.acceptanceCriteria.length > 0 && <div className="mt-3 border-t border-[#eee3d9] pt-2 text-[11px] leading-5 text-[#877b70]"><div className="mb-1 font-medium text-[#71665c]">验收标准</div>{plan.acceptanceCriteria.slice(0, 4).map((item) => <div key={item} className="flex gap-1.5"><span className="text-[#a77a58]">•</span><span>{item}</span></div>)}</div>}</div>;
}

function WorkflowTimeline({ events }: { events: WorkflowEvent[] }) {
  if (!events.length) return null;
  return <div className="space-y-1.5 rounded-2xl border border-[#eceae5] bg-white px-4 py-3"><p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.13em] text-[#aaa39a]">执行记录</p>{events.slice(-9).map((event, index, visible) => { const failed = event.type === "tool_failed" || event.type === "error" || event.type === "structure_check_failed" || event.type === "verify_failed" || ((event.type === "validation_done" || event.type === "quality_review_done" || event.type === "inspect_done" || event.type === "page_done" || event.type === "images_done" || event.type === "visual_fix_reverted") && event.ok === false); const done = event.type === "intent" || event.type === "plan_ready" || event.type === "tool_completed" || event.type === "validation_done" || event.type === "quality_review_done" || event.type === "inspect_done" || event.type === "page_done" || event.type === "visual_review_done" || event.type === "images_done" || event.type === "completed"; return <div key={`${event.type}-${event.label}-${index}`} className={`flex items-start gap-2 text-[11px] leading-4 ${failed ? "text-[#b05e49]" : "text-[#81796f]"}`}>{failed ? <CircleAlert className="mt-0.5 h-3 w-3 shrink-0 text-[#c06d52]" /> : done || index < visible.length - 1 ? <Check className="mt-0.5 h-3 w-3 shrink-0 text-[#8aa17b]" /> : <LoaderCircle className="mt-0.5 h-3 w-3 shrink-0 animate-spin text-[#b4774b]" />}<span className="break-words">{event.label || event.message || (event.type === "plan_ready" ? "计划已生成" : event.type)}</span></div>; })}</div>;
}

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([
    { role: "assistant", text: "我已经准备好帮你搭建网站了。描述你想创建的网站，或者直接告诉我怎么修改当前预览。我会先分析需求和项目结构，再分批修改真实代码，最后构建、校验并自动修复。" },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("项目预览");
  const [apiKey, setApiKey] = useState("");
  const [keyLoaded, setKeyLoaded] = useState(false);
  const [previewUrl, setPreviewUrl] = useState(initialPreviewUrl);
  const [files, setFiles] = useState<AgentFile[]>([]);
  const [mobilePreview, setMobilePreview] = useState(false);
  const [plan, setPlan] = useState<SitePlan | null>(null);
  const [runEvents, setRunEvents] = useState<WorkflowEvent[]>([]);

  useEffect(() => {
    window.localStorage.removeItem("deepseek-copilot-messages");
    const savedApiKey = window.localStorage.getItem("deepseek-copilot-api-key");
    const savedPreviewUrl = window.localStorage.getItem("deepseek-copilot-preview-url");
    const savedFiles = window.localStorage.getItem("deepseek-copilot-files");
    if (savedApiKey) setApiKey(savedApiKey);
    setKeyLoaded(true);
    if (savedPreviewUrl) setPreviewUrl(savedPreviewUrl);
    if (savedFiles) {
      try { setFiles(JSON.parse(savedFiles) as AgentFile[]); } catch { window.localStorage.removeItem("deepseek-copilot-files"); }
    }
  }, []);

  useEffect(() => {
    if (keyLoaded) window.localStorage.setItem("deepseek-copilot-api-key", apiKey);
    window.localStorage.setItem("deepseek-copilot-preview-url", previewUrl);
    window.localStorage.setItem("deepseek-copilot-files", JSON.stringify(files));
  }, [apiKey, keyLoaded, previewUrl, files]);

  function refreshPreview() {
    setStatus("正在构建当前项目");
    setPreviewUrl(`/api/preview?projectId=${projectId}&v=${Date.now()}`);
  }

  async function submit(raw = input) {
    const message = raw.trim();
    if (!message || busy) return;
    setInput("");
    setBusy(true);
    setStatus("正在分析需求");
    setPlan(null);
    setRunEvents([]);
    setMessages((current) => [...current, { role: "user", text: message }]);
    try {
      const response = await fetch("/api/agent/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // 带上最近几轮对话（不含开场白），让后端能理解“刚才那个”“再改一点”。
        body: JSON.stringify({ message, projectId, apiKey, history: messages.slice(1).slice(-8).map(({ role, text }) => ({ role, text })) }),
      });
      if (!response.ok) {
        const errorText = await response.text();
        let detail = errorText;
        try { detail = (JSON.parse(errorText) as { error?: string }).error || errorText; } catch { /* keep text */ }
        throw new Error(detail || `接口请求失败（HTTP ${response.status}）`);
      }
      if (!response.body) throw new Error("浏览器没有返回流式响应");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const handle = (event: WorkflowEvent) => {
        setRunEvents((current) => [...current, event]);
        if (event.type === "stage" || event.type === "intent" || event.type === "validation_started" || event.type === "repair_started") setStatus(event.label || "处理中");
        if (event.type === "plan_ready" && event.plan) setPlan(event.plan);
        if (event.type === "error") throw new Error(event.message || event.error || "建站失败");
        if (event.type === "completed" && event.result) {
          const result = event.result;
          setFiles(result.files);
          setPlan(result.plan || null);
          if (result.previewUrl) setPreviewUrl(result.previewUrl);
          const validationLabel = result.readOnly ? "只读检查完成" : result.validation?.ok ? "已完成项目更新" : "代码已更新，但验收未通过";
          const reviewLabel = result.qualityReview && !result.readOnly ? ` · 内容审查 ${result.qualityReview.score} 分` : "";
          setStatus(`${validationLabel}${reviewLabel} · ${result.files.length} 个文件${result.validation?.cached ? " · 使用缓存预览" : ""}`);
          const reply = result.validation?.error && !result.readOnly ? `${result.reply}\n\n验收未通过：${result.validation.error}` : result.reply;
          setMessages((current) => [...current, { role: "assistant", text: reply, changes: result.events }]);
        }
      };
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) if (line.trim()) handle(JSON.parse(line) as WorkflowEvent);
      }
      if (buffer.trim()) handle(JSON.parse(buffer) as WorkflowEvent);
    } catch (error) {
      setStatus("需要重试");
      setMessages((current) => [...current, { role: "assistant", text: error instanceof Error ? error.message : "这次修改没有完成，请检查配置后重试。" }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="h-screen overflow-hidden bg-[#f7f7f5] text-[#242321]">
      <header className="flex h-[68px] items-center justify-between border-b border-[#e7e6e1] bg-white px-5 sm:px-7">
        <div className="flex items-center gap-4">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-[#2d2925] text-white shadow-sm"><WandSparkles className="h-4 w-4" /></div>
          <div><div className="text-sm font-semibold tracking-tight">AI 建站 Copilot</div><div className="hidden text-[11px] text-[#9a9891] sm:block">DeepSeek 驱动的持续建站工作台</div></div>
        </div>
        <div className="flex items-center gap-2">
          <span className="hidden rounded-full border border-[#e5e3dd] bg-[#fcfbf8] px-3 py-1.5 text-[11px] text-[#77736c] sm:inline-flex">DeepSeek Flash</span>
          <div className="flex items-center gap-1 rounded-lg border border-[#e5e3dd] bg-[#fcfbf8] px-2">
            <label htmlFor="deepseek-key-header" className="sr-only">DeepSeek API Key</label>
            <input id="deepseek-key-header" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="DeepSeek API Key" autoComplete="off" className="w-[110px] bg-transparent py-2 text-xs text-[#423c35] outline-none placeholder:text-[#aaa39a] sm:w-[170px]" />
            {apiKey && <span className="text-[10px] text-[#8aa17b]">已缓存</span>}
          </div>
          <button onClick={refreshPreview} className="inline-flex items-center gap-2 rounded-lg border border-[#e5e3dd] bg-white px-3 py-2 text-xs font-medium hover:bg-[#faf9f5]"><RefreshCw className="h-3.5 w-3.5" />刷新预览</button>
        </div>
      </header>

      <div className="grid h-[calc(100vh-68px)] grid-cols-[380px_minmax(0,1fr)] max-xl:grid-cols-[340px_minmax(0,1fr)] max-md:grid-cols-1">
        <aside className="order-1 flex min-h-0 flex-col border-r border-[#e7e6e1] bg-white max-md:h-[52vh] max-md:border-r-0 max-md:border-b">
          <div className="flex items-center justify-between border-b border-[#efeee9] px-5 py-4">
            <div><p className="text-sm font-semibold">Copilot 会话</p><p className="mt-0.5 text-[11px] text-[#aaa69e]">分析需求 · 执行修改 · 构建校验 · 自动修复</p></div>
            <div className="flex items-center gap-2 text-[#aaa69e]"><History className="h-4 w-4" /><PanelRight className="h-4 w-4" /></div>
          </div>
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5">
            {messages.map((message, index) => (
              <div key={`${message.role}-${index}`} className={message.role === "user" ? "ml-8" : "mr-4"}>
                <div className={`rounded-2xl px-4 py-3 text-sm leading-6 ${message.role === "user" ? "rounded-br-md bg-[#f0eee9] text-[#413c36]" : "rounded-bl-md border border-[#eceae5] bg-white text-[#5f5a53]"}`}>
                  {message.role === "assistant" && <div className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.13em] text-[#b4774b]"><Sparkles className="h-3 w-3" /> DeepSeek Copilot</div>}
                  <div className="whitespace-pre-wrap">{message.text}</div>
                  {message.changes?.length ? <div className="mt-3 space-y-1 border-t border-[#eeeae4] pt-2 text-[11px] text-[#8c857b]">{message.changes.map((change, changeIndex) => <div key={`${change}-${changeIndex}`} className="flex gap-2"><Check className="mt-0.5 h-3 w-3 shrink-0 text-[#8aa17b]" />{change}</div>)}</div> : null}
                </div>
              </div>
            ))}
            {plan && <PlanCard plan={plan} />}
            <WorkflowTimeline events={runEvents} />
            {busy && <div className="mr-4 flex items-center gap-2 text-xs text-[#a29d94]"><span className="flex gap-1"><i className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#b4774b]" /><i className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#b4774b] [animation-delay:120ms]" /><i className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#b4774b] [animation-delay:240ms]" /></span>{status}</div>}
          </div>
          <div className="border-t border-[#efeee9] p-4">
            <div className="mb-3 flex gap-2 overflow-x-auto pb-1 scrollbar-none">{starterPrompts.map((prompt) => <button key={prompt} onClick={() => submit(prompt)} disabled={busy} className="shrink-0 rounded-full border border-[#e7e3dc] bg-[#fcfbf8] px-3 py-1.5 text-[11px] text-[#777067] transition hover:border-[#c9a17c] hover:text-[#8b5d3e] disabled:opacity-50">{prompt}</button>)}</div>
            <form onSubmit={(event) => { event.preventDefault(); submit(); }} className="relative rounded-2xl border border-[#dedbd4] bg-[#fcfbf8] p-3 shadow-[0_6px_20px_rgba(55,45,35,.05)] focus-within:border-[#b58c69]">
              <textarea value={input} onChange={(event) => setInput(event.target.value)} placeholder="描述你想创建或修改的网站..." rows={3} className="w-full resize-none bg-transparent pr-10 text-sm leading-6 text-[#423c35] outline-none placeholder:text-[#b5afa6]" />
              <button type="submit" disabled={!input.trim() || busy} className="absolute bottom-3 right-3 grid h-8 w-8 place-items-center rounded-xl bg-[#2d2925] text-white transition hover:bg-[#b4774b] disabled:cursor-not-allowed disabled:opacity-30"><ArrowUp className="h-4 w-4" /></button>
            </form>
            <p className="mt-2 text-center text-[10px] text-[#b2ada5]">Agent 会先分析，再修改必要文件并检查预览</p>
          </div>
        </aside>

        <section className="order-2 relative min-w-0 overflow-y-auto bg-[#f0f0ed] p-4 sm:p-7">
          <div className="mx-auto flex max-w-6xl items-center justify-between pb-4">
            <div><p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#aaa69e]">网站预览</p><p className="mt-1 text-xs text-[#7e7a72]">{status} · {files.length ? `${files.length} 个真实项目文件` : "当前骨架项目"}</p></div>
            <div className="flex items-center gap-1 rounded-lg border border-[#dfded9] bg-white p-1"><button onClick={() => setMobilePreview(false)} className={`rounded-md p-2 ${!mobilePreview ? "bg-[#2d2925] text-white" : "text-[#928e87] hover:bg-[#f7f6f2]"}`} aria-label="桌面预览"><Monitor className="h-4 w-4" /></button><button onClick={() => setMobilePreview(true)} className={`rounded-md p-2 ${mobilePreview ? "bg-[#2d2925] text-white" : "text-[#928e87] hover:bg-[#f7f6f2]"}`} aria-label="手机预览"><Smartphone className="h-4 w-4" /></button></div>
          </div>
          <div className={`mx-auto overflow-hidden bg-white shadow-2xl transition-all duration-500 ${mobilePreview ? "max-w-[390px] rounded-[2rem] border-[8px] border-[#252525]" : "w-full rounded-xl"}`}><iframe title="AI 生成的网站预览" src={previewUrl} className="h-[calc(100vh-150px)] min-h-[680px] w-full border-0 bg-white" sandbox="allow-scripts allow-forms" /></div>
        </section>
      </div>
    </main>
  );
}
