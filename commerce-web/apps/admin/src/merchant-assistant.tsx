import { BrandLogo } from "@commerce/ui";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError, queryMerchant, merchantHistory, type MerchantAnswer, type MerchantInput } from "@commerce/api-client";
import { merchantDates, merchantQuestions, merchantQuestionLabels } from "./merchant-questions";
import "./merchant-assistant.css";
import { merchantInsight } from "./merchant-insights";

export function MerchantAssistant({ onClose, initialQuestion }: { onClose: () => void; initialQuestion?: MerchantInput["question"] }) {
  const initial = merchantQuestions.find(item => item.question === initialQuestion) ?? merchantQuestions[0];
  const dialog = useRef<HTMLDialogElement>(null);
  const request = useRef<AbortController>();
  const [question, setQuestion] = useState<MerchantInput["question"]>(initial.question);
  const [dates, setDates] = useState(merchantDates(initial.question));
  const [customize, setCustomize] = useState(false);
  const quick = merchantQuestions.find(item => item.question === question)?.setup === "quick";
  const datedReport = question !== "low_stock" && question !== "order_status";
  const [currency, setCurrency] = useState("USD");
  const [order, setOrder] = useState("");
  const [stock, setStock] = useState(5);
  const [sales, setSales] = useState(2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [answers, setAnswers] = useState<MerchantAnswer[]>([]);
  const [conversation, setConversation] = useState<string>(() => crypto.randomUUID());
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [prompts, setPrompts] = useState<Record<string, string>>({});
  const transcript = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = transcript.current;
    if (!element) return;
    const latest = element.querySelector<HTMLElement>(".merchant-turn:last-child");
    if (busy) element.scrollTop = element.scrollHeight;
    else if (latest) element.scrollTop += latest.getBoundingClientRect().top - element.getBoundingClientRect().top;
  }, [answers, busy]);
  const [recent, setRecent] = useState<MerchantAnswer[]>([]);
  const selection = useRef(0);
  useEffect(() => { let active=true; void merchantHistory().then(async rows => { if(active) {setRecent(rows); if(rows.length) {const messages=await merchantHistory(rows[0].conversation_id); if(active) {setAnswers(messages.reverse());setConversation(rows[0].conversation_id);}}}}).catch(() => {if(active)setError("Previous conversations could not be loaded.");}).finally(() => {if(active)setLoadingHistory(false);}); return () => {active=false;}; }, []);
  async function loadConversation(id: string) {
    const revision=++selection.current; setLoadingHistory(true);setError("");
    try {const rows=await merchantHistory(id);if(selection.current===revision){setAnswers(rows.reverse());setConversation(id);}}
    catch {if(selection.current===revision)setError("Conversation could not be loaded.");}
    finally {if(selection.current===revision)setLoadingHistory(false);}
  }
  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    element?.showModal();
    return () => { request.current?.abort(); element?.close(); document.body.style.overflow = overflow; previous?.focus(); };
  }, []);
  function choose(item: typeof merchantQuestions[number]) {
    setCustomize(false); setQuestion(item.question); setDates(merchantDates(item.question));
    setStock(item.question === "slow_stock" ? 50 : 5); setError("");
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || loadingHistory) return;
    if (!question) { setError("Choose a supported question below. Set dates, currency and thresholds in the fields; I could not safely match every part of that request. Use the fields for filters, or choose a suggested question."); return; }
    if (question === "order_status" && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(order)) { setError("Enter the order UUID from the order record."); return; }
    const start = Date.parse(`${dates.from}T00:00:00Z`), end = Date.parse(`${dates.to}T00:00:00Z`);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || end - start > 365 * 86400000 || dates.to > new Date().toISOString().slice(0,10)) { setError("Choose a valid UTC date range of up to 366 days, ending no later than today."); return; }
    const input: MerchantInput = { request_id:crypto.randomUUID(),conversation_id:conversation,question, ...dates, currency, scope: "installation", order_id: question === "order_status" ? order : null, stock_threshold: stock, sales_threshold: sales };
    const controller = new AbortController(); request.current = controller;
    const timer = window.setTimeout(() => controller.abort("timeout"), 12000);
    setBusy(true); setError("");
    try {
      const answer = await queryMerchant(input, controller.signal);
      if (!controller.signal.aborted) { setPrompts(current => ({ ...current, [answer.request_id]: merchantQuestionLabels[question] })); setAnswers(current => [...current, answer]); setRecent(current => [answer,...current.filter(row => row.conversation_id!==answer.conversation_id)].slice(0,20)); }
    } catch (e) {
      if (controller.signal.aborted) { if (controller.signal.reason === "timeout") setError("The query timed out. Please retry."); }
      else setError(e instanceof ApiError && e.status === 429 ? "Too many requests. Wait a moment and try again." : e instanceof ApiError && e.status === 403 ? "Your role does not permit this question." : e instanceof ApiError && e.status === 401 ? "Please sign in again." : e instanceof ApiError && e.status === 400 ? e.message : "Commerce data is temporarily unavailable. Please retry.");
    } finally { window.clearTimeout(timer); if (!controller.signal.aborted || controller.signal.reason === "timeout") setBusy(false); }
  }
  return <dialog className="merchant-assistant" ref={dialog} aria-labelledby="merchant-title" onCancel={onClose}>
    <aside className="merchant-rail" aria-label="Assistant navigation">
      <BrandLogo iconOnly />
      <button type="button" disabled={busy || loadingHistory} onClick={() => { setConversation(crypto.randomUUID()); setAnswers([]); setHistoryOpen(false); setError(""); }}><span aria-hidden="true">＋</span>New chat</button>
      <button type="button" aria-expanded={historyOpen} aria-controls="merchant-history" onClick={() => setHistoryOpen(value => !value)}><span aria-hidden="true">◷</span>History</button>
      <button type="button" className="merchant-back" onClick={onClose}><span aria-hidden="true">←</span>Admin</button>
    </aside>
    <header className="merchant-header"><div><h2 id="merchant-title">Admin assistant</h2><span className="merchant-beta">BETA</span></div><button type="button" aria-label="Close assistant" onClick={onClose}>Back to admin <span aria-hidden="true">×</span></button></header>
    <div className="merchant-workspace">
      {historyOpen && <section id="merchant-history" className="merchant-history" aria-label="Conversation history"><h3>Recent conversations</h3>{recent.length ? recent.map(row => <button key={row.conversation_id} disabled={busy || loadingHistory} onClick={() => { void loadConversation(row.conversation_id); setHistoryOpen(false); }}>{row.title}<small>{new Date(row.evaluated_at).toLocaleString()}</small></button>) : <p>No saved conversations yet.</p>}</section>}
      <div className="merchant-transcript" ref={transcript}>
        {!answers.length && !busy && <section className="merchant-welcome"><div className="merchant-welcome-symbol"><BrandLogo iconOnly /></div><p className="merchant-eyebrow">A HELPING HAND FOR YOUR BUSINESS</p><h3>How can I help today?</h3><p>Explore your orders, inventory and sales.</p></section>}
        <div className="merchant-messages" role="log" aria-label="Merchant assistant answers" aria-live="polite" aria-busy={busy}>{answers.map(answer => <div className="merchant-turn" key={answer.request_id}>
          <div className="merchant-customer-message"><small>You</small><p>{prompts[answer.request_id] || merchantQuestionLabels[answer.question]}</p></div>
          <article className="merchant-reply"><div className="merchant-avatar"><BrandLogo iconOnly /></div><div className="merchant-reply-body"><strong className="merchant-author">Rocento assistant</strong><MerchantResult answer={answer} /></div></article>
        </div>)}{busy && <p className="merchant-progress" role="status">Reading commerce records…</p>}</div>
      </div>
      <div className="merchant-composer-wrap"><nav className="merchant-quick-questions merchant-question-groups" aria-label="Predefined questions">{(["quick", "details"] as const).map(group => <section key={group} aria-label={group === "quick" ? "Quick questions" : "Needs details"}><p>{group === "quick" ? "Quick questions" : "Needs details"}</p><div className="merchant-suggestions">{merchantQuestions.filter(item => item.setup === group).map(item => <button key={item.question} type="button" disabled={busy || loadingHistory} aria-pressed={question === item.question} onClick={() => choose(item)}>{item.label}</button>)}</div></section>)}</nav><form className="merchant-composer" onSubmit={submit}>
        {quick && <div className="merchant-preset"><span>{dates.from === dates.to ? `${customize ? "" : "Today · "}${dates.from}` : `${dates.from} — ${dates.to}`} · UTC · {currency}</span><button type="button" disabled={busy} aria-expanded={customize} aria-controls="merchant-report-filters" onClick={() => { if (customize) setDates(merchantDates(question)); setCustomize(value => !value); }}>{customize ? "Use preset" : "Customize filters"}</button></div>}
        {(!quick || customize) && <section id="merchant-report-filters" className="merchant-filters" aria-label={question === "order_status" ? "Order lookup" : "Report filters"}><div className="merchant-filter-fields">
          <div className="merchant-fields">{datedReport && <><label>From (UTC)<input type="date" required value={dates.from} disabled={busy} onChange={e => { setDates({ ...dates, from:e.target.value }); }} /></label><label>To (UTC)<input type="date" required value={dates.to} disabled={busy} onChange={e => { setDates({ ...dates, to:e.target.value }); }} /></label></>}{question !== "order_status" && <label>Currency<input required pattern="[A-Z]{3}" maxLength={3} value={currency} disabled={busy} onChange={e => setCurrency(e.target.value.toUpperCase())} /></label>}</div>
          {(question === "low_stock" || question === "slow_stock") && <label>{question === "low_stock" ? "Maximum available stock" : "Minimum available stock"}<input type="number" min={0} max={1000000} required disabled={busy} value={stock} onChange={e => setStock(Number(e.target.value))} /></label>}
          {question === "slow_stock" && <label>Maximum ordered units in period<input type="number" min={0} max={1000000} required disabled={busy} value={sales} onChange={e => setSales(Number(e.target.value))} /></label>}
          {question === "order_status" && <label>Order ID<input required placeholder="Paste the order UUID" value={order} disabled={busy} onChange={e => setOrder(e.target.value.trim())} /></label>}
          <p className="merchant-scope">Read-only · This installation{datedReport ? " · UTC dates" : question === "low_stock" ? " · Current inventory" : " · Current order details"}</p>
        </div></section>}
        <div className="merchant-composer-actions"><span>{loadingHistory ? "Loading history…" : merchantQuestionLabels[question]}</span><button className="merchant-run-report" type="submit" disabled={busy || loadingHistory}>{busy ? "Running report…" : "Run report"}</button></div>
        {error && <p className="merchant-error" role="alert">{error}</p>}
      </form><p className="merchant-footer">A helping hand from Rocento. Answers grounded in your business data.</p></div>
    </div>
  </dialog>;
}
export function MerchantResult({ answer }: { answer: MerchantAnswer }) {
  const insight = merchantInsight(answer);
  return <section className="merchant-result"><h3>{answer.title}</h3><div className="merchant-result-meta"><span>{answer.from === answer.to ? answer.from : `${answer.from} — ${answer.to}`} · UTC</span><span>{answer.currency}</span><span>Read-only report</span></div>
    <div className="merchant-insight"><h4>Summary</h4><p className="merchant-finding">{insight.summary}</p>{insight.caveat && <p className="merchant-caveat">{insight.caveat}</p>}</div>
    {answer.rows.length > 0 && <div className="merchant-table" tabIndex={0} role="region" aria-label={answer.title}><table><caption>Report details <span>· {answer.rows.length} {answer.rows.length === 1 ? "record" : "records"} · {answer.currency}</span></caption><thead><tr>{answer.columns.map(c => <th key={c} scope="col">{c}</th>)}</tr></thead><tbody>{answer.rows.map((row, i) => <tr key={i}>{row.map((cell,j) => <td key={j}>{answer.columns[j] === "Status" ? cell.replaceAll("_", " ") : cell}</td>)}</tr>)}</tbody></table></div>}
    {insight.nextStep && <div className="merchant-next-step"><h4>Suggested next step</h4><p>{insight.nextStep}</p></div>}
    <section className="merchant-evidence" aria-label="Source, scope and calculation rules">
      <h4>About this report</h4>
      <div className="merchant-evidence-grid">{["Source", "Scope", "Calculation rules"].map(label => {
        const notes = answer.notes.flatMap(note => note.split(/ (?=Scope:|Currency is never converted)/));
        const selected = notes.filter(note => label === "Source" ? note.startsWith("Source:") : label === "Scope" ? note.startsWith("Scope:") : !/^(Source|Scope):/.test(note));
        return selected.length > 0 && <section key={label}><h5>{label}</h5><ul>{selected.map((note,i) => <li key={i}>{note.replace(/^(Source|Scope):\s*/, "")}</li>)}</ul></section>;
      })}</div>
      <dl className="merchant-evidence-meta"><div><dt>Snapshot taken</dt><dd>{new Intl.DateTimeFormat("en", {dateStyle:"medium", timeStyle:"short", timeZone:"UTC"}).format(new Date(answer.evaluated_at))} UTC</dd></div><div><dt>Report reference</dt><dd><code>{answer.request_id}</code></dd></div></dl>
    </section>
    {answer.truncated && <p>First 20 results shown; more matches exist.</p>}
  </section>;
}
