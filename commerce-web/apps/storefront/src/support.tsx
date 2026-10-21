import { useInterface } from './interface-locale';
import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ApiError,
  escalateAssistant,
  supportApi,
  type Customer,
  type SupportDetail,
  type SupportInput,
} from "@commerce/api-client";
import { Notice } from "@commerce/ui";
import {
  humanizeSupportValue,
  supportCategories,
  supportNextAction,
  supportPriorityTone,
  supportSlaLabel,
  supportStatusTone,
} from "./support-logic";
import "./support.css";

function StatusBadge({
  value,
  tone,
}: {
  value: string;
  tone: "success" | "pending" | "danger";
}) {
  const {t: ui} = useInterface();
  return (
    <span className={`support-badge ${tone}`}>
      {ui(`support.value.${value}`,humanizeSupportValue(value))}
    </span>
  );
}

function MessageTimeline({ detail }: { detail: SupportDetail }) {
  const {t: ui, locale} = useInterface();
  return (
    <section className="support-thread" aria-label={ui("support.ticket_conversation", "Ticket conversation")}>
      {detail.messages.map((message) => (
        <article className={`support-message ${message.sender}`} key={message.id}>
          <header>
            <strong>{ui(`support.value.${message.sender}`,humanizeSupportValue(message.sender))}</strong>
            <time>{new Date(message.created_at).toLocaleString(locale)}</time>
          </header>
          <p>{message.body}</p>
        </article>
      ))}
    </section>
  );
}

export function SupportForm({
  customer,
  orderId,
  viaAssistant = false,
  onCreated,
}: {
  customer: Customer | null;
  orderId?: string;
  viaAssistant?: boolean;
  onCreated?: (detail: SupportDetail) => void;
}) {
  const {t: ui, message} = useInterface();
  const [form, setForm] = useState<SupportInput>({
    request_id: crypto.randomUUID(),
    subject: "",
    category: "other",
    body: "",
    order_id: orderId,
  });
  const [attempt, setAttempt] = useState<SupportInput>();
  const [result, setResult] = useState<SupportDetail>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const navigate = useNavigate();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const body = attempt || form;
    setAttempt(body);
    try {
      const created =
        viaAssistant && customer
          ? await escalateAssistant(body).catch(() => supportApi.create(body))
          : await supportApi.create(body);
      setResult(created);
      onCreated?.(created);
    } catch (e) {
      setError(e instanceof Error ? e.message : ui("support.could_not_submit_ticket", "Could not submit ticket"));
      if (e instanceof ApiError && [400, 422].includes(e.status)) {
        setAttempt(undefined);
      }
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <section className="support-confirmation" role="status">
        <p className="eyebrow">{ui("support.support_case_created", "SUPPORT CASE CREATED")}</p>
        <h2>{ui("support.ticket_number_is_open", "Ticket #{number} is open", {number:String(result.ticket.number)})}</h2>
        <p>{ui("support.your_message_has_been_received_keep_your_ticket_number_for_reference", "Your message has been received. Keep your ticket number for reference.")}</p>
        <div className="support-summary-strip">
          <article>
            <span>{ui("support.status", "Status")}</span>
            <StatusBadge
              value={result.ticket.status}
              tone={supportStatusTone(result.ticket.status)}
            />
          </article>
          <article>
            <span>{ui("support.priority", "Priority")}</span>
            <StatusBadge
              value={result.ticket.priority}
              tone={supportPriorityTone(result.ticket.priority)}
            />
          </article>
          <article>
            <span>{ui("support.next_action", "Next action")}</span>
            <strong>{message(supportNextAction(result.ticket))}</strong>
          </article>
        </div>
        {customer ? (
          <div className="support-confirmation-actions">
            <button
              type="button"
              className="primary-link"
              onClick={() =>
                navigate(`/assistant?ticket=${result.ticket.id}`, {
                  replace: viaAssistant,
                })
              }
            >{ui("support.track_in_ai_assistance", "Track in AI assistance")}</button>
            <Link
              className="primary-link secondary"
              to={`/account/tickets/${result.ticket.id}`}
            >{ui("support.view_your_ticket_and_replies", "View your ticket and replies")}</Link>
          </div>
        ) : (
          <p>{ui("support.our_team_can_follow_up_using_the_contact_details_you_provided", "Our team can follow up using the contact details you provided.")}</p>
        )}
      </section>
    );
  }

  return (
    <section className="support-intake">
      <div className="support-heading">
        <h1>{ui("support.open_a_support_ticket", "Open a support ticket")}</h1>
        <p>{ui("support.how_can_we_help", "How can we help?")}</p>
      </div>
      <form className="support-form" onSubmit={submit} aria-busy={busy}>
        {orderId && <p className="support-order-context">{ui("support.regarding", "Regarding")}{" "}<Link to={`/account/orders/${orderId}`}>{ui("support.your_order", "your order")}</Link></p>}
        <Notice error>{message(error)}</Notice>
        <fieldset disabled={busy || !!attempt}>
          <label>{ui("support.subject", "Subject")}<input
              required
              maxLength={160}
              placeholder={ui("support.briefly_describe_your_issue", "Briefly describe your issue")}
              value={form.subject}
              onChange={(e) => setForm({ ...form, subject: e.target.value })}
            />
          </label>
          <label>{ui("storefront.category", "Category")}<select
              value={form.category}
              onChange={(e) =>
                setForm({
                  ...form,
                  category: e.target.value as SupportInput["category"],
                })
              }
            >
              {supportCategories.map((category) => (
                <option key={category} value={category}>
                  {ui(`support.value.${category}`,humanizeSupportValue(category))}
                </option>
              ))}
            </select>
          </label>
          <label>{ui("support.message", "Message")}<textarea
              required
              maxLength={2000}
              rows={7}
              aria-describedby="support-message-count"
              value={form.body}
              onChange={(e) => setForm({ ...form, body: e.target.value })}
            />
            <span id="support-message-count" className="support-message-count">{ui("support.count_2_000_characters", "{count} / 2,000 characters", {count:form.body.length})}</span>
          </label>
          {!customer && (
            <div className="support-contact-grid">
              <label>{ui("support.your_name", "Your name")}<input
                  required
                  maxLength={100}
                  autoComplete="name"
                  value={form.contact_name || ""}
                  onChange={(e) =>
                    setForm({ ...form, contact_name: e.target.value })
                  }
                />
              </label>
              <label>{ui("storefront.email_or_mobile_number", "Email or mobile number")}<input
                  required
                  maxLength={254}
                  autoComplete="email"
                  placeholder={ui("support.you_example_com_or_201012345678", "you@example.com or +201012345678")}
                  value={form.contact || ""}
                  onChange={(e) => setForm({ ...form, contact: e.target.value })}
                />
              </label>
            </div>
          )}
        </fieldset>
        <div className="support-actions">
          <button disabled={busy}>
            {busy
              ? ui("support.submitting", "Submitting...")
              : attempt
                ? ui("support.retry_saved_submission", "Retry saved submission")
                : ui("support.open_ticket", "Open ticket")}
          </button>
          {attempt && error && (
            <p>{ui("support.your_message_is_saved_for_retry_you_will_not_receive_a_duplicate_ticket", "Your message is saved for retry. You will not receive a duplicate ticket.")}</p>
          )}
        </div>
        {customer && <p className="support-existing"><Link to="/account/tickets">{ui("support.view_your_existing_tickets", "View your existing tickets")}</Link></p>}
      </form>
    </section>
  );
}

export function CustomerTickets({ customer }: { customer: Customer | null }) {
  const {t: ui, message} = useInterface();
  const { id } = useParams();
  const list = useQuery({
    queryKey: ["support", customer?.id],
    queryFn: supportApi.list,
    enabled: !!customer && !id,
  });
  const detail = useQuery({
    queryKey: ["support", customer?.id, id],
    queryFn: () => supportApi.detail(id!),
    enabled: !!customer && !!id,
    refetchInterval: 10000,
  });
  const [body, setBody] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [requestId, setRequestId] = useState<string>(() => crypto.randomUUID());

  if (!customer) {
    return (
      <main className="support-page">
        <h1>{ui("support.your_support_tickets", "Your support tickets")}</h1>
        <Link className="primary-link" to="/login">{ui("support.sign_in_to_view_your_tickets", "Sign in to view your tickets")}</Link>
      </main>
    );
  }

  async function submitReply(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await supportApi.reply(id!, requestId, body);
      setBody("");
      setRequestId(crypto.randomUUID());
      await detail.refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : ui("support.reply_failed", "Reply failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="support-page">
      <Link to="/account" className="back-link">{ui("navigation.account", "My account")}</Link>
      <div className="support-heading">
        <p className="eyebrow">{ui("support.support_center", "SUPPORT CENTER")}</p>
        <h1>
          {detail.data
            ? ui("support.ticket_number", "Ticket #{number}", {number:String(detail.data.ticket.number)})
            : ui("support.your_support_tickets", "Your support tickets")}
        </h1>
      </div>
      <Notice error>{message(error || list.error?.message || detail.error?.message || "")}</Notice>
      {!id && (
        <>
          <div className="support-list-head">
            <p>{ui("support.count_recent_tickets", "{count} recent tickets", {count:list.data?.length ?? 0})}</p>
            <Link className="primary-link" to="/support">{ui("support.open_a_ticket", "Open a ticket")}</Link>
          </div>
          <div className="support-ticket-list">
            {list.data?.map((ticket) => (
              <Link
                className="support-ticket-row"
                key={ticket.id}
                to={`/account/tickets/${ticket.id}`}
              >
                <span>
                  <strong>
                    #{ticket.number} · {ticket.subject}
                  </strong>
                  <small>
                    {ui(`support.value.${ticket.category}`,humanizeSupportValue(ticket.category))} ·{" "}
                    {message(supportSlaLabel(ticket))}
                  </small>
                </span>
                <StatusBadge
                  value={ticket.status}
                  tone={supportStatusTone(ticket.status)}
                />
              </Link>
            ))}
          </div>
        </>
      )}
      {detail.data && (
        <section className="support-detail">
          <div className="support-summary-strip">
            <article>
              <span>{ui("support.status", "Status")}</span>
              <StatusBadge
                value={detail.data.ticket.status}
                tone={supportStatusTone(detail.data.ticket.status)}
              />
            </article>
            <article>
              <span>{ui("support.priority", "Priority")}</span>
              <StatusBadge
                value={detail.data.ticket.priority}
                tone={supportPriorityTone(detail.data.ticket.priority)}
              />
            </article>
            <article>
              <span>{ui("support.next_action", "Next action")}</span>
              <strong>{message(supportNextAction(detail.data.ticket))}</strong>
            </article>
          </div>
          <h2>{detail.data.ticket.subject}</h2>
          <p>
            {ui(`support.value.${detail.data.ticket.category}`,humanizeSupportValue(detail.data.ticket.category))}
            {detail.data.ticket.order_id && (
              <>
                {" "}
                ·{" "}
                <Link to={`/account/orders/${detail.data.ticket.order_id}`}>{ui("support.linked_order", "Linked order")}</Link>
              </>
            )}
          </p>
          <MessageTimeline detail={detail.data} />
          <form className="form-card support-reply" onSubmit={submitReply}>
            <label>{ui("support.reply", "Reply")}<textarea
                required
                maxLength={2000}
                rows={5}
                value={body}
                onChange={(e) => {
                  setBody(e.target.value);
                  setRequestId(crypto.randomUUID());
                }}
              />
            </label>
            <button disabled={busy}>{busy ? ui("support.sending", "Sending...") : ui("support.send_reply", "Send reply")}</button>
          </form>
        </section>
      )}
    </main>
  );
}
