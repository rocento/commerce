import { EntityIdHeading, EntityIdCell } from "./entity-id";
import { RowActions } from "./row-actions";
import { PageHeader } from "./page-header";
import { useGrid } from "./grids";
import { useMemo, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { adminSupportApi, type SupportTicket } from "@commerce/api-client";
import { Notice } from "@commerce/ui";

const statuses: SupportTicket["status"][] = [
  "open",
  "in_progress",
  "resolved",
  "closed",
];

function humanize(value: string) {
  return value.replaceAll("_", " ");
}

function statusTone(status: SupportTicket["status"]) {
  if (status === "resolved" || status === "closed") return "success";
  if (status === "in_progress") return "pending";
  return "danger";
}

function priorityTone(priority: SupportTicket["priority"]) {
  return priority === "high" ? "danger" : "pending";
}

export function SupportTickets({ canWrite }: { canWrite: boolean }) {
  const { id } = useParams();
  const list = useGrid("support", ["admin-support"], {}, !id);
  const detail = useQuery({
    queryKey: ["admin-support", id],
    queryFn: () => adminSupportApi.detail(id!),
    enabled: !!id,
    refetchInterval: 10000,
  });
  const [body, setBody] = useState("");
  const [status, setStatus] =
    useState<SupportTicket["status"]>("in_progress");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [requestId, setRequestId] = useState<string>(() => crypto.randomUUID());
  const counts = useMemo(
    () =>
      statuses.map((status) => ({
        status,
        count:
          list.data?.filter((ticket) => ticket.status === status).length ?? 0,
      })),
    [list.data],
  );

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await adminSupportApi.reply(id!, requestId, body, status);
      setBody("");
      setRequestId(crypto.randomUUID());
      await detail.refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Reply failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="support-admin">
      <Link to="/support/tickets">Support tickets</Link>
      <PageHeader title={<>
            {detail.data
              ? `Ticket #${detail.data.ticket.number}`
              : "Support tickets"}
          </>} description={<>
            Review customer issues, prioritize urgent cases, and record replies.
          </>} />
      <Notice error>{error || list.error?.message || detail.error?.message}</Notice>
      {!id && (
        <>
          <section className="metric-grid support-metrics">
            {counts.map((item) => (
              <article key={item.status}>
                <span>{humanize(item.status)}</span>
                <strong>{item.count}</strong>
                <small>Current queue</small>
              </article>
            ))}
          </section>
          {list.controls}
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <EntityIdHeading/><th>Ticket</th>
                  <th>Subject</th>
                  <th>Category</th>
                  <th>Priority</th>
                  <th>Status</th>
                  <th>Created</th><th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {list.data?.map((ticket) => (
                  <tr key={ticket.id}>
                    <EntityIdCell row={ticket}/><td>
                      <Link to={`/support/tickets/${ticket.id}`}>
                        #{ticket.number}
                      </Link>
                    </td>
                    <td>{ticket.subject}</td>
                    <td>{humanize(ticket.category)}</td>
                    <td>
                      <span
                        className={`status-pill ${priorityTone(ticket.priority)}`}
                      >
                        {humanize(ticket.priority)}
                      </span>
                    </td>
                    <td>
                      <span
                        className={`status-pill ${statusTone(ticket.status)}`}
                      >
                        {humanize(ticket.status)}
                      </span>
                    </td>
                    <td>{new Date(ticket.created_at).toLocaleString()}</td><td><RowActions label={`ticket #${ticket.number}`} items={[{label:"View ticket",to:`/support/tickets/${ticket.id}`}]} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {detail.data && (
        <section className="order-view support-ticket-view">
          <div className="order-titlebar">
            <div>
              <h2>{detail.data.ticket.subject}</h2>
              <p>
                {humanize(detail.data.ticket.category)} ·{" "}
                {detail.data.messages.length} messages
              </p>
            </div>
            <div className="order-actions">
              <span
                className={`status-pill ${priorityTone(detail.data.ticket.priority)}`}
              >
                {humanize(detail.data.ticket.priority)}
              </span>
              <span
                className={`status-pill ${statusTone(detail.data.ticket.status)}`}
              >
                {humanize(detail.data.ticket.status)}
              </span>
            </div>
          </div>
          <div className="order-summary-strip">
            <article>
              <span>Created</span>
              <strong>
                {new Date(detail.data.ticket.created_at).toLocaleString()}
              </strong>
            </article>
            <article>
              <span>Contact</span>
              <strong>{detail.data.contact || "Authenticated customer"}</strong>
            </article>
            <article>
              <span>Contact name</span>
              <strong>{detail.data.contact_name || "Customer account"}</strong>
            </article>
            <article>
              <span>Order</span>
              <strong>
                {detail.data.ticket.order_id ? (
                  <Link to={`/sales/orders/${detail.data.ticket.order_id}`}>
                    Linked order
                  </Link>
                ) : (
                  "No linked order"
                )}
              </strong>
            </article>
          </div>
          <section className="order-panel">
            <h2>Conversation</h2>
            {detail.data.messages.map((message) => (
              <article className="support-admin-message" key={message.id}>
                <strong>
                  {humanize(message.sender)} ·{" "}
                  {new Date(message.created_at).toLocaleString()}
                </strong>
                <p>{message.body}</p>
              </article>
            ))}
          </section>
          {canWrite && (
            <form className="order-panel" onSubmit={submit}>
              <h2>Reply and status</h2>
              <label className="field">
                <span>Reply or follow-up note</span>
                <textarea
                  required
                  maxLength={2000}
                  rows={6}
                  value={body}
                  onChange={(e) => {
                    setBody(e.target.value);
                    setRequestId(crypto.randomUUID());
                  }}
                />
              </label>
              <label className="field">
                <span>Status</span>
                <select
                  value={status}
                  onChange={(e) => {
                    setStatus(e.target.value as SupportTicket["status"]);
                    setRequestId(crypto.randomUUID());
                  }}
                >
                  {statuses.map((status) => (
                    <option key={status} value={status}>
                      {humanize(status)}
                    </option>
                  ))}
                </select>
              </label>
              <button disabled={busy}>
                {busy ? "Saving..." : "Save reply and status"}
              </button>
            </form>
          )}
        </section>
      )}
    </main>
  );
}
