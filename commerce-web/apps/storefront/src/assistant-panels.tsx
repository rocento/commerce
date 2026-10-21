import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { UseQueryResult } from "@tanstack/react-query";
import type { parseAssistantHistory, SupportDetail, SupportInput } from "@commerce/api-client";
import { Icon } from "./assistant-chrome";
import { AssistantMemory } from "./assistant-memory";
import { humanizeSupportValue, supportCategories } from "./support-logic";
import type { useAssistantTicketFlow } from "./assistant-ticket-flow";

type HistoryProps = {
  open: boolean;
  customerKey?: string;
  conversationId: string;
  busy: boolean;
  history: UseQueryResult<ReturnType<typeof parseAssistantHistory>, Error>;
  personalize: boolean;
  onPersonalize: (value: boolean) => void;
  onNewChat: () => void;
  onOpenConversation: (id: string) => void;
};

export function AssistantHistoryPanel({ open, customerKey, conversationId, busy, history, personalize, onPersonalize, onNewChat, onOpenConversation }: HistoryProps) {
  const [search, setSearch] = useState("");
  useEffect(() => { if (open) setSearch(""); }, [open]);
  const grouped = new Map<string, { id: string; title: string; created: string; updated: string; matches: boolean }>();
  const needle = search.trim().toLocaleLowerCase();
  for (const turn of history.data ?? []) {
    const current = grouped.get(turn.conversation_id);
    const matches = `${turn.question} ${turn.answer}`.toLocaleLowerCase().includes(needle);
    if (!current) grouped.set(turn.conversation_id, { id: turn.conversation_id, title: turn.question, created: turn.created_at, updated: turn.created_at, matches });
    else {
      if (turn.created_at < current.created) { current.title = turn.question; current.created = turn.created_at; }
      if (turn.created_at > current.updated) current.updated = turn.created_at;
      current.matches ||= matches;
    }
  }
  const conversations = [...grouped.values()].sort((a, b) => b.updated.localeCompare(a.updated));
  const matchingConversations = conversations.filter(item => item.matches);
  return <>
    <div className="assistant-history-heading"><img src="/brand/favicon-32.png" width="32" height="32" alt="Rocento" /><div><h2>Conversations</h2><p>Your recent chats, all in one place.</p></div></div>
    <button className="assistant-new-chat" disabled={busy} onClick={onNewChat}><Icon name="plus" /> New conversation</button>
    {customerKey && <label className="assistant-history-search">Search conversations<input type="search" placeholder="Search your chats…" value={search} onChange={event => setSearch(event.target.value)} /></label>}
    <AssistantMemory conversation={conversationId} customerKey={customerKey ?? "guest"} personalize={personalize} onPersonalize={onPersonalize} busy={busy}/>
    <div className="assistant-history">
      <h2>Recent conversations</h2>
      {!customerKey ? <p><Link to="/login">Sign in</Link> to keep your conversations in one place.</p> : history.isPending ? <p role="status">Loading conversations…</p> : history.isError ? <div role="alert"><p>History is temporarily unavailable.</p><button className="text-button assistant-text-button" onClick={() => void history.refetch()}>Retry</button></div> : !conversations.length ? <p>A fresh start. Your conversations will appear here.</p> : !matchingConversations.length ? <p role="status">No conversations match your search.</p> : matchingConversations.map(item => <button
        className={`text-button assistant-history-item ${item.id === conversationId ? "is-active" : ""}`}
        key={item.id} disabled={busy} aria-current={item.id === conversationId ? "true" : undefined}
        onClick={() => onOpenConversation(item.id)}
      ><Icon name="chat" /><span><strong>{item.title}</strong><time dateTime={item.updated}>{new Date(item.updated).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</time></span></button>)}
    </div>
    <div className="assistant-history-privacy"><Icon name="account" /><span>{customerKey ? "Conversations are private to your account." : "You’re browsing as a guest."}</span></div>
  </>;
}

export function AssistantTicketCard({ detail, refreshing, expanded, onToggle }: { detail: SupportDetail; refreshing: boolean; expanded: boolean; onToggle: () => void }) {
  return (
  <div className="assistant-ticket-card">
    <div className="assistant-order-label">
      <Icon name="chat" /> Ticket update{" "}
      <span>{refreshing ? 'Refreshing support details…' : 'Support details'}</span>
    </div>
    <div className="assistant-ticket-body">
      <div>
        <span>Ticket</span>
        <strong>#{detail.ticket.number}</strong>
      </div>
      <div>
        <span>Status</span>
        <strong>
          {detail.ticket.status.replaceAll("_", " ")}
        </strong>
      </div>
      <div>
        <span>Priority</span>
        <strong>{detail.ticket.priority}</strong>
      </div>
      <div>
        <span>Subject</span>
        <strong>{detail.ticket.subject}</strong>
      </div>
    </div>
    <p className="assistant-ticket-latest">
      Latest:{" "}
      {detail.messages.at(-1)?.body ||
        "Waiting for the first update."}
    </p>
    <button
      type="button"
      className="assistant-sign-in assistant-ticket-toggle"
      aria-expanded={expanded}
      onClick={onToggle}
    >
      {expanded ? "Hide conversation" : "View conversation"}
      <span aria-hidden="true">{expanded ? "⌃" : "⌄"}</span>
    </button>
    {expanded && (
      <section className="assistant-ticket-thread" aria-label={`Conversation for ticket ${detail.ticket.number}`}>
        {detail.messages.map((message) => (
          <article className={`assistant-ticket-message ${message.sender}`} key={message.id}>
            <header>
              <strong>{message.sender.replaceAll("_", " ")}</strong>
              <time dateTime={message.created_at}>{new Date(message.created_at).toLocaleString()}</time>
            </header>
            <p>{message.body}</p>
          </article>
        ))}
      </section>
    )}
  </div>
  );
}

type IntakeProps = {
  ticketDraft: SupportInput;
  ticketStep: ReturnType<typeof useAssistantTicketFlow>["ticketStep"];
  ticketPosting: boolean;
  ticketSubmitError: string;
  attempted: boolean;
  busy: boolean;
  onSubmit: () => Promise<void>;
  onCancel: () => void;
  onCategory: (category: string) => void;
};
export function AssistantTicketIntake({ ticketDraft, ticketStep, ticketPosting, ticketSubmitError, attempted, busy, onSubmit, onCancel, onCategory }: IntakeProps) {
  return <section className="checkout-chat-message assistant-ticket-intake" aria-label="Support ticket conversation" aria-busy={ticketPosting}>
  {ticketStep === 'review' && <><strong>Review ticket</strong><h3>{ticketDraft.subject}</h3><p>Category: {humanizeSupportValue(ticketDraft.category)}</p><p style={{ whiteSpace: 'pre-wrap' }}>{ticketDraft.body}</p>{ticketDraft.contact && <p>Reply to: {ticketDraft.contact_name} · {ticketDraft.contact}</p>}{ticketDraft.order_id && <p>This ticket is linked to your selected order.</p>}
    {ticketSubmitError && <p role="alert">{ticketSubmitError} Your request is saved for retry.</p>}
    <button type="button" disabled={ticketPosting} onClick={() => void onSubmit()}>{ticketPosting ? 'Opening ticket…' : attempted ? 'Retry saved ticket' : 'Open ticket'}</button>
  </>}
  {ticketStep === 'category' && <div className="assistant-ticket-categories" role="group" aria-label="Ticket category">
    {supportCategories.map(category => <button key={category} type="button" className="secondary" disabled={busy || ticketPosting} onClick={() => {
      onCategory(humanizeSupportValue(category));
    }}>{humanizeSupportValue(category)}</button>)}
  </div>}
  {!attempted && <button type="button" className="text-button" onClick={onCancel}>Cancel ticket</button>}
  </section>;
}
