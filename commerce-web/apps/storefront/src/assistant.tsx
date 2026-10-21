import { useAssistantTicketFlow } from "./assistant-ticket-flow";
import { AssistantAuth } from "./assistant-auth";
import { isCheckoutRequest } from "./assistant-checkout-intent";
import { isTicketRequest } from "./assistant-ticket-intent";
import type { CheckoutReplyHandler } from "./checkout-replies";
import { Checkout } from "./checkout";
import { discoverAssistantProducts, assistantProductBlock } from './assistant-discovery';
import { useDeliveryKey } from './locations';
import { AssistantReorder } from "./assistant-reorder";
import { assistantSessionParams } from "./assistant-ticket-navigation";
import { comparisonIds, comparisonPrompt } from "./comparison-model";
import { AssistantDeliveryProvider, AssistantDeliveryButton } from "./assistant-delivery";
import { useAssistantDelivery } from "./assistant-delivery-context";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { BrandLogo } from "@commerce/ui";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  assistantHistory,
  saveAssistantDeliveryEvent,
  parseAssistantHistory,
  supportApi,
  type AssistantInput,
  type Customer,
} from "@commerce/api-client";
import { useCart } from "./cart";
import { AssistantSelectionContext, selectionInput, selectionForMessage, useAssistantSelection, type AssistantSelection } from "./assistant-selection";
import { AssistantOrderDetails } from "./assistant-order-details";
import { AssistantOrders } from "./assistant-orders";

import { AssistantWishlistWatcher, AssistantRichResponse } from "./assistant-rich";
import { AssistantClarification } from "./assistant-clarification";
import { AssistantMarkdown } from "./assistant-markdown";
import { type Message } from "./assistant-state";
import { useAssistantStream } from "./assistant-stream";
import { Icon, Sheet } from "./assistant-chrome";
import "./assistant.css";
import { AssistantHistoryPanel, AssistantTicketCard, AssistantTicketIntake } from "./assistant-panels";

function CatalogShelf({ onRecommend, onCompare }: { onRecommend: () => void; onCompare: (routes: string[], names: string[]) => void }) {
  const delivery = useDeliveryKey();
  const selection = useAssistantSelection();
  const catalog = useQuery({
    queryKey: ["assistant-discovery", "", delivery],
    queryFn: ({ signal }) => discoverAssistantProducts("", signal),
    staleTime: 30000,
  });
  return (
    <section className="assistant-catalog" aria-label="Browse the catalog">
      <div className="assistant-section-heading">
        <div>
          <h2>A little inspiration</h2>
          <p>
            From the store’s catalog. Choose a quantity and add it to your cart
            right here.
          </p>
        </div>
        <Link to="/search">
          Shop all <Icon name="chevron" />
        </Link>
      </div>
      {catalog.isPending ? (
        <div
          className="assistant-products"
          role="status"
          aria-label="Loading products"
        >
          {[0, 1, 2].map((i) => (
            <div className="assistant-product-skeleton" key={i} />
          ))}
        </div>
      ) : catalog.isError ? (
        <div className="assistant-inline-notice">
          The catalog is taking a moment.{" "}
          <button onClick={() => void catalog.refetch()}>Try again</button>
        </div>
      ) : catalog.data?.length ? (
        <AssistantRichResponse blocks={[assistantProductBlock(catalog.data.slice(0, 3))]} busy={selection?.busy ?? false} onCompare={onCompare} />
      ) : (
        <p className="assistant-caption">
          No products to show yet. <Link to="/search">Explore the store</Link>
        </p>
      )}
      <button className="text-button assistant-text-button" onClick={onRecommend}>
        Ask for a recommendation <span aria-hidden="true">↗</span>
      </button>
    </section>
  );
}

export function Assistant({ customer, onAuthenticated }: { customer: Customer | null; onAuthenticated: (customer: Customer) => void }) {
  const [authMessages, setAuthMessages] = useState<Message[]>([]);
  const [params, setParams] = useSearchParams();
  useEffect(() => {
    if (params.has("shopping") || params.has("task")) {
      const next = new URLSearchParams(params);
      next.delete("shopping");
      next.delete("task");
      setParams(next, { replace: true });
    }
  }, [params, setParams]);
  return <AssistantDeliveryProvider key={customer?.id ?? "guest"} customer={customer}><AssistantSession key={`${customer?.id ?? "guest"}:${assistantSessionParams(params)}`} customer={customer} initialMessages={authMessages} onAuthenticated={(account, messages) => { setAuthMessages(messages); onAuthenticated(account); }} /></AssistantDeliveryProvider>;
}
function AssistantSession({ customer, initialMessages, onAuthenticated }: { customer: Customer | null; initialMessages: Message[]; onAuthenticated: (customer: Customer, messages: Message[]) => void }) {
  const [authMode, setAuthMode] = useState<"login" | "register" | null>(null);
  const authActions = <div className="assistant-auth-actions"><button type="button" onClick={() => setAuthMode("login")}>Log in</button><button type="button" onClick={() => setAuthMode("register")}>Register</button></div>;
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [checkoutStarted, setCheckoutStarted] = useState(false);
  const checkoutPanel = useRef<HTMLDivElement>(null);
  const checkoutReply = useRef<CheckoutReplyHandler | null>(null);
  const registerCheckoutReply = useCallback((handler: CheckoutReplyHandler | null) => { checkoutReply.current = handler; }, []);
  const openCheckout = () => {
    if (!customer) {
      setMessages(current => [...current, { role: "assistant", text: "Please log in or register to complete your order. Your cart stays with you.", login: true }]);
      return;
    }
    setCheckoutStarted(true);
    setCheckoutOpen(true);
    requestAnimationFrame(() => {
      const panel = checkoutPanel.current;
      const conversation = thread.current;
      if (!panel || !conversation) return;
      // Scroll only the conversation; scrolling hidden ancestors can shift
      // the workspace and expose the page background below the composer.
      conversation.scrollTo({
        top: conversation.scrollTop + panel.getBoundingClientRect().top - conversation.getBoundingClientRect().top,
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      });
    });
  };
  const delivery = useAssistantDelivery();
  const [params, setParams] = useSearchParams();
  const cache = useQueryClient();
  const savedConversation = params.get("conversation");
  const hydrated = useRef(false);
  const rawOrder = savedConversation ? null : params.get("order");
  const rawTicket = params.get("ticket");
  const orderId =
    rawOrder && /^[0-9a-f-]{36}$/i.test(rawOrder) ? rawOrder : undefined;
  const linkedTicketId = rawTicket && /^[0-9a-f-]{36}$/i.test(rawTicket) ? rawTicket : undefined;
  const [ticketId, setTicketId] = useState<string | undefined>(linkedTicketId);
  useEffect(() => { setTicketId(linkedTicketId); }, [linkedTicketId]);
  function showTicketDetails(id: string, number: number) {
    if (sending.current || (savedConversation && customer && selectedHistory.isPending)) return;
    setCheckoutOpen(false); setShowHistory(false); setShowTickets(false);
    follow.current = true; setScrolledUp(false); setExpandedTicketId(id);
    setMessages(current => {
      const existing = current.find(message => message.ticket?.ticket.id === id);
      return [...current.filter(message => message !== existing),
        { role: 'customer', text: `Show details for ticket #${number}` },
        ...(existing ? [existing] : []),
      ];
    });
    setTicketId(id);
    if (id === ticketId) void ticket.refetch();
  }
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [conversationId, setConversationId] = useState<string>(() =>
    savedConversation && /^[0-9a-f-]{36}$/i.test(savedConversation) ? savedConversation : (()=>{try{const id=sessionStorage.getItem(`rocento-context:${customer?.id??'guest'}`);if(id&&/^[0-9a-f-]{36}$/i.test(id))return id;}catch{}return crypto.randomUUID();})(),
  );
  const selectionKey = `rocento-selection:${customer?.id ?? "guest"}:${conversationId}`;
  const [selection, setSelection] = useState<AssistantSelection | undefined>(() =>
    orderId ? { kind: "order", id: orderId } : undefined,
  );
  const selectedOrder = selection?.kind === "order" ? selection : undefined;
  const selectedOrderId = selectedOrder?.id;
  const { cart } = useCart();
  useEffect(() => {
    try {
      localStorage.removeItem(selectionKey);
      localStorage.removeItem(`rocento-order:${customer?.id ?? "guest"}:${conversationId}`);
    } catch { /* Selection still works for this session. */ }
  }, [selectionKey, selection, customer?.id, conversationId]);
  const [personalize,setPersonalize] = useState(true);
  const [showHistory, setShowHistory] = useState(false);
  const history = useQuery({
    queryKey: ["assistant-history", customer?.id],
    queryFn: async () => parseAssistantHistory(await assistantHistory()),
    enabled: !!customer,
  });
  const ticket = useQuery({
    queryKey: ["assistant-ticket", customer?.id, ticketId],
    queryFn: () => supportApi.detail(ticketId!),
    enabled: !!customer && !!ticketId,
    refetchInterval: 10000,
  });
  const [showTickets, setShowTickets] = useState(false);
  const tickets = useQuery({
    queryKey: ["assistant-tickets", customer?.id],
    queryFn: supportApi.list,
    enabled: !!customer && showTickets && !messages.length,
    refetchInterval: 10000,
  });
  const [text, setText] = useState(orderId ? "Where is my order?" : savedConversation ? "" : comparisonPrompt(comparisonIds(params.get("compare"))));
  const [showCatalog, setShowCatalog] = useState(false);
  const [expandedTicketId, setExpandedTicketId] = useState<string | undefined>(ticketId);
  useEffect(() => { if (ticketId) setExpandedTicketId(ticketId); }, [ticketId]);
  const selectedHistory = useQuery({ queryKey:["assistant-conversation",customer?.id,savedConversation], queryFn:async () => parseAssistantHistory(await assistantHistory(savedConversation ?? undefined)), enabled:Boolean(customer && savedConversation) });
  const [scrolledUp, setScrolledUp] = useState(false);
  const thread = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const follow = useRef(true);
  const sending = useRef(false);
  const [dismissedClarification, setDismissedClarification] = useState<string>();
  const { busy, error, setError, failureDetails, stopped, progress, last, sendResponse, stopResponse, resetStream } = useAssistantStream({
    conversationId, customer, personalize, sending, setMessages, setSelection,
    onBegin: () => { follow.current = true; setScrolledUp(false); },
    onCheckout: requestId => { setDismissedClarification(requestId); openCheckout(); },
    onSettled: () => { composer.current?.focus(); if (customer) void history.refetch(); setPersonalize(true); },
  });
  function ticketReply(message: string, response: string) {
    follow.current = true; setScrolledUp(false);
    setMessages(current => [...current, { role: 'customer', text: message }, { role: 'assistant', text: response }]);
  }
  const { ticketDraft, ticketStep, ticketPosting, ticketSubmitError, ticketAttempted, startTicket, createChatTicket, handleTicketReply, resetTicket } = useAssistantTicketFlow({
    customer, selectedOrderId, loadingHistory: Boolean(savedConversation && customer && selectedHistory.isPending), sending,
    onBegin: () => { setCheckoutOpen(false); setShowHistory(false); },
    focusComposer: () => composer.current?.focus(),
    ticketReply,
    onConfirmation: message => setMessages(current => [...current, { role: 'customer', text: message }]),
    onCreated: detail => {
      setTicketId(detail.ticket.id); setExpandedTicketId(detail.ticket.id); void tickets.refetch(); follow.current = true;
      setMessages(current => [...current, { role: 'assistant', text: 'Your ticket is open. Our team will follow up here.', ticket: detail }]);
    },
  });
  const subscribeToDeliveryUpdates = delivery?.subscribeToUpdates;
  useEffect(() => subscribeToDeliveryUpdates?.((message, locationId) => {
    follow.current = true;
    setScrolledUp(false);
    const requestId = crypto.randomUUID();
    setMessages(current => [...current,
      { role: "customer", text: "Delivery location selected" },
      { role: "assistant", text: message, requestId, completed: true, createdAt: new Date().toISOString() },
    ]);
    if (customer && locationId) void saveAssistantDeliveryEvent(conversationId, requestId, locationId).then(() => {
      setMessages(current => current.map(item => item.requestId === requestId ? {...item, saved:true} : item));
      void cache.invalidateQueries({queryKey:["assistant-history",customer.id]});
    }).catch(() => setError("Your location is updated, but this confirmation could not be saved to chat history."));
  }), [subscribeToDeliveryUpdates, customer, conversationId, cache, setError]);
  useEffect(() => {
    if (!savedConversation || selectedHistory.isFetching || !selectedHistory.data || hydrated.current) return;
    hydrated.current = true;
    const turns = selectedHistory.data.filter((turn) => turn.conversation_id === savedConversation);
    setMessages([...turns].reverse().flatMap(turn => [
      { role: "customer" as const, text: turn.question },
      { role: "assistant" as const, text: turn.answer, responseSource: turn.response_source, blocks: turn.blocks, requestId: turn.request_id, helpful: turn.helpful, saved:true, createdAt:turn.created_at },
    ]));
    if (!turns.length) setError("This conversation is no longer available in your recent history.");
  }, [savedConversation, selectedHistory.data, selectedHistory.isFetching, setError]);
  const scrollToLatest = useCallback((smooth = false) => {
    const element = thread.current;
    if (element)
      element.scrollTo({
        top: element.scrollHeight,
        behavior:
          smooth &&
          !window.matchMedia("(prefers-reduced-motion: reduce)").matches
            ? "smooth"
            : "auto",
      });
  }, []);
  useEffect(() => {
    if (messages.length && follow.current) scrollToLatest();
    if (!messages.length)
      thread.current?.scrollTo({ top: 0, behavior: "instant" });
  }, [messages, busy, error, showCatalog, scrollToLatest]);
  useEffect(() => {
    if (!ticket.data || busy || (savedConversation && !hydrated.current)) return;
    const detail = ticket.data;
    setMessages((current) => {
      const existing = current.findIndex((m) => m.ticket?.ticket.id === detail.ticket.id);
      if (existing >= 0) return current.map((m, i) => i === existing ? { ...m, ticket: detail } : m);
      return [...current, { role: "assistant", text: "Your support ticket is being tracked here.", ticket: detail }];
    });
  }, [ticket.data, busy, savedConversation, selectedHistory.data]);
  useEffect(() => {
    const viewport = window.visualViewport;
    const shell = thread.current?.closest<HTMLElement>(
      ".assistant-store-shell",
    );
    if (!viewport || !shell) return;
    const resize = () => {
      shell.style.setProperty(
        "--assistant-viewport-height",
        `${viewport.height}px`,
      );
      if (follow.current && sending.current) scrollToLatest();
    };
    resize();
    viewport.addEventListener("resize", resize);
    return () => {
      viewport.removeEventListener("resize", resize);
      shell.style.removeProperty("--assistant-viewport-height");
    };
  }, [scrollToLatest]);
  useEffect(() => {
    const field = composer.current;
    if (field) {
      field.style.height = "auto";
      field.style.height = `${Math.min(field.scrollHeight, 144)}px`;
    }
  }, [text]);
  async function send(input: AssistantInput, retry = false, displayMessage?: string) {
    if (sending.current || (savedConversation && customer && selectedHistory.isPending)) return;
    if (isTicketRequest(input.message)) { startTicket(input.message); return; }
    if (isCheckoutRequest(input.message)) { startCheckoutFromMessage(displayMessage ?? input.message); return; }
    return sendResponse(input, retry, displayMessage);
  }
  const latestResponse = messages[messages.length - 1];
  const replyContext = latestResponse?.role === "assistant" && latestResponse.completed && !latestResponse.failure && latestResponse.requestId !== dismissedClarification ? latestResponse.clarification : undefined;
  function startCheckoutFromMessage(message: string) {
    setSelection(undefined);
    setDismissedClarification(latestResponse?.requestId);
    setMessages(current => [...current, { role: "customer", text: message }]);
    follow.current = true;
    setScrolledUp(false);
    // The existing checkout owns loading, empty-cart, sign-in and validation states.
    openCheckout();
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!text.trim() || busy || ticketPosting || (savedConversation && customer && selectedHistory.isPending)) return;
    const message = text;
    setText("");
    if (handleTicketReply(message)) return;
    if (isTicketRequest(message)) { startTicket(message); return; }
    if (isCheckoutRequest(message)) { startCheckoutFromMessage(message); return; }
    const checkoutResponse = checkoutOpen ? checkoutReply.current?.(message) : null;
    if (checkoutResponse) {
      // Checkout renders its own step messages and confirmation receipts.
      follow.current = true;
      return;
    }
    // An unrelated request ends the short-reply context; reopening checkout restores it.
    if (checkoutOpen) setCheckoutOpen(false);
    // The main composer starts a request; only the inline form answers a clarification.
    const context = selectionForMessage(selection, message);
    setDismissedClarification(latestResponse?.requestId);
    setSelection(context);
    void send({ request_id: crypto.randomUUID(), message, ...selectionInput(context) });
  }
  function selectProduct(product: { id: string; name: string }) {
    if (sending.current) return;
    setSelection({ kind: "product", ...product });
    setDismissedClarification(latestResponse?.requestId);
    composer.current?.focus();
  }
  function showCart() {
    if (sending.current) return;
    setSelection({ kind: "cart" });
    setDismissedClarification(latestResponse?.requestId);
    void send({ request_id: crypto.randomUUID(), message: "Show my cart", cart_context: true });
  }
  function openOrder(order: { id: string; number: number }) {
    if (sending.current || (savedConversation && customer && selectedHistory.isPending)) return;
    setSelection({ kind: "order", id: order.id, number: order.number });
    setDismissedClarification(latestResponse?.requestId);
    void send({ request_id: crypto.randomUUID(), message: `Where is my order #${order.number}?`, order_id: order.id });
  }
  function startReorder(order: { id: string; number: number }) {
    if (sending.current) return;
    follow.current = true;
    setScrolledUp(false);
    setCheckoutOpen(false);
    setSelection({ kind: "order", ...order });
    setMessages(current => [...current,
      { role: "customer", text: `Reorder order #${order.number}` },
      { role: "assistant", text: `Let’s reorder #${order.number}.`, requestId: crypto.randomUUID(), reorder: order },
    ]);
  }
  function showOrders() {
    if (sending.current || (savedConversation && customer && selectedHistory.isPending)) return;
    setCheckoutOpen(false);
    setSelection(undefined);
    setDismissedClarification(latestResponse?.requestId);
    void send({ request_id: crypto.randomUUID(), message: "Show my orders" });
  }
  function newChat() {
    if (ticketPosting) return;
    resetTicket(); setTicketId(undefined); setExpandedTicketId(undefined);
    setCheckoutOpen(false);
    setCheckoutStarted(false);
    try { sessionStorage.removeItem(`rocento-context:${customer?.id ?? "guest"}`); } catch {}
    if (params.size) { setParams({}); if (assistantSessionParams(params)) return; }
    setExpandedTicketId(undefined);
    setText("");
    resetStream();
    setMessages([]);
    setConversationId(crypto.randomUUID());
    setShowHistory(false);
    setShowCatalog(false);
    setShowTickets(false);
    setSelection(undefined);
    follow.current = true;
    composer.current?.focus();
  }

  return (
    <AssistantSelectionContext.Provider value={{ busy, selectProduct, selectCart: showCart, startCheckout: openCheckout, startReorder }}>
    <main className="assistant-page" lang="en" dir="ltr">
      <nav className="assistant-rail" aria-label="Assistant navigation">
        <Link className="assistant-rail-logo" to="/" aria-label="Rocento home" title="Back to website"><img src="/brand/favicon-32.png" width="32" height="32" alt="" /></Link>
        <div className="assistant-rail-primary">
          <button type="button" className="assistant-rail-action icon-button" disabled={busy} onClick={newChat} aria-label="New conversation" title="New conversation"><Icon name="plus" /><span>New chat</span></button>
          <button type="button" className="assistant-rail-action icon-button" onClick={() => setShowHistory(true)} aria-label="Open conversations" aria-haspopup="dialog" aria-expanded={showHistory} title="Conversation history"><Icon name="chat" /><span>History</span></button>
        </div>
        <div className="assistant-rail-bottom">
          <Link className="assistant-rail-action icon-button" to={customer ? "/account" : "/login"} aria-label={customer ? "Your account" : "Sign in"} title={customer ? "Your account" : "Sign in"}><Icon name="account" /><span>{customer ? "Account" : "Sign in"}</span></Link>
        </div>
      </nav>
      <Sheet
        open={showHistory}
        onClose={() => setShowHistory(false)}
        label="Conversation navigation"
        className="assistant-navigation-sheet"
      >
        <AssistantHistoryPanel open={showHistory} customerKey={customer?.id} conversationId={conversationId} busy={busy} history={history} personalize={personalize} onPersonalize={setPersonalize} onNewChat={newChat} onOpenConversation={id => { setShowHistory(false); setParams({ conversation: id }); }} />
      </Sheet>
      <section
        className="assistant-conversation"
        aria-label="Shopping conversation"
      >
        <div className="assistant-topbar">
          <div>
            <span className="assistant-toolbar-title">Shopping assistant</span>
            <span className="assistant-beta">BETA</span>
          </div>
          <div className="assistant-toolbar-actions">
          <Link className="assistant-back" to="/">
            <span className="direction-icon" aria-hidden="true">←</span> Back to website
          </Link>
          <button
            className="text-button assistant-text-button assistant-toolbar-support"
            onClick={() => startTicket()}
          >
            <Icon name="chat" />
            <span>Get support</span>
          </button>
          <AssistantDeliveryButton customer={customer} />
          <button type="button" className="assistant-cart-context-button" disabled={busy} onClick={showCart}><Icon name="bag" /> Cart <span>{cart?.items.reduce((sum, item) => sum + item.quantity, 0) ?? 0}</span></button>
          </div>
        </div>
        <div
          ref={thread}
          className="assistant-thread"
          onScroll={() => {
            const el = thread.current;
            if (el) {
              follow.current =
                el.scrollHeight - el.scrollTop - el.clientHeight < 100;
              setScrolledUp(!follow.current);
            }
          }}
        >
          <div className="assistant-content">
            {!messages.length ? (
              <section className="assistant-welcome">
                <div className="assistant-welcome-symbol">
                  <BrandLogo iconOnly />
                </div>
                <p className="assistant-eyebrow">A LITTLE HELP, EVERY DAY</p>
                <p className="assistant-welcome-copy">
                  Let’s make shopping a little easier.
                </p>
                <div className="assistant-prompts">
                  <button type="button" className="secondary" disabled={busy} onClick={() => void send({ request_id: crypto.randomUUID(), message: "Where is my last order?" })}>
                    <Icon name="box" />
                    <strong>Where is my last order?</strong>
                    <span className="assistant-prompt-arrow" aria-hidden="true">
                      ↗
                    </span>
                  </button>
                  <button
                    className="secondary"
                    type="button"
                    disabled={busy}
                    onClick={() => void send({ request_id: crypto.randomUUID(), message: "Recommend a product for today" })}
                  >
                    <Icon name="bag" />
                    <strong>Recommended today</strong>
                    <span className="assistant-prompt-arrow" aria-hidden="true">
                      ↗
                    </span>
                  </button>
                  {failureDetails?.recovery === "sign_in" && authActions}
                  {failureDetails?.recovery === "browse_catalog" && <Link to="/search">Browse catalog</Link>}
                  {failureDetails?.recovery === "refresh_proposal" && <button onClick={() => void cache.invalidateQueries({ queryKey: ["shopping-task", conversationId] })}>Refresh proposal</button>}
                  <button type="button" className="text-button" disabled={busy} aria-expanded={showTickets} aria-controls="assistant-ticket-shelf" onClick={() => setShowTickets(value => !value)}>
                    <Icon name="chat" />
                    <strong>Show my tickets</strong>
                    <span className="assistant-prompt-arrow" aria-hidden="true">
                      ↗
                    </span>
                  </button>
                  {([
                    { label: "Find best sellers", icon: "bag", message: "Recommend best-selling products" },
                    { label: "Best discounts today", icon: "spark", message: "Recommend products with the best discounts today" },
                    { label: "Best value items", icon: "box", message: "Recommend the best value products" },
                  ] as const).map(prompt => (
                    <button key={prompt.label} type="button" className="secondary" disabled={busy} onClick={() => void send({ request_id: crypto.randomUUID(), message: prompt.message })}>
                      <Icon name={prompt.icon} />
                      <strong>{prompt.label}</strong>
                      <span className="assistant-prompt-arrow" aria-hidden="true">↗</span>
                    </button>
                  ))}
                </div>
                {showTickets && !customer && <p className="assistant-caption"><Link to="/login">Sign in to view your tickets</Link></p>}
                {showTickets && customer && (
                  <section
                    id="assistant-ticket-shelf"
                    className="assistant-ticket-shelf"
                    aria-label="Tracked support tickets"
                  >
                    <div className="assistant-section-heading">
                      <div>
                        <h2>Support tickets</h2>
                        <p>Track your open cases without leaving assistance.</p>
                      </div>
                      <button
                        className="text-button assistant-text-button"
                        onClick={() => void tickets.refetch()}
                      >
                        Refresh
                      </button>
                    </div>
                    {tickets.isPending ? (
                      <p className="assistant-caption" role="status">
                        Loading tickets...
                      </p>
                    ) : tickets.isError ? (
                      <div className="assistant-inline-notice">
                        Tickets are taking a moment.{" "}
                        <button onClick={() => void tickets.refetch()}>
                          Try again
                        </button>
                      </div>
                    ) : tickets.data?.length ? (
                      <div className="assistant-ticket-list">
                        {tickets.data.slice(0, 4).map((item) => (
                          <button
                            type="button"
                            disabled={busy || ticketPosting || (!!savedConversation && !!customer && selectedHistory.isPending)}
                            className="assistant-ticket-row"
                            key={item.id}
                            onClick={() => showTicketDetails(item.id, item.number)}
                          >
                            <span>
                              <strong>
                                #{item.number} · {item.subject}
                              </strong>
                              <small>
                                {item.category.replaceAll("_", " ")} ·{" "}
                                {item.priority} priority
                              </small>
                            </span>
                            <em>{item.status.replaceAll("_", " ")}</em>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <p className="assistant-caption">
                        No tickets yet. Open one here and it will appear in this
                        page.
                      </p>
                    )}
                  </section>
                )}
              </section>
            ) : (
              <div
                className="assistant-messages"
                role="log"
                aria-label="Messages"
                aria-live="polite"
                aria-relevant="additions text"
              >
                {messages.map((m, i) => {
                  const pending = busy && m.requestId === last?.request_id;
                  return (
                    <article
                      key={i}
                      className={`assistant-message ${m.role}`}
                      aria-label={
                        m.role === "customer"
                          ? "Your message"
                          : "Assistant response"
                      }
                    >
                      {m.role === "assistant" && (
                        <span className="assistant-message-avatar">
                          <BrandLogo iconOnly />
                        </span>
                      )}
                      <div className="assistant-message-body">
                        <span className="assistant-message-author">
                          {m.role === "customer" ? "You" : "Rocento assistant"}
                          {m.role === "assistant" && m.responseSource && <span className="assistant-response-source">{m.responseSource}</span>}
                        </span>
                        {m.createdAt && <p className="assistant-saved-note">Saved response · {new Date(m.createdAt).toLocaleString()}. Product facts may have changed.</p>}
                        {!!m.blocks?.length && <AssistantRichResponse
                          customerId={customer?.id} blocks={m.blocks} busy={busy} onCheckout={openCheckout} onSupport={() => startTicket()}
                          onCompoundConfirm={i === messages.length - 1 && m.completed && !m.failure ? message => void send({ request_id: crypto.randomUUID(), message }) : undefined}
                          onRecommend={i === messages.length - 1 ? message => void send({ request_id: crypto.randomUUID(), message }) : undefined}
                          onRemoveProduct={(id, name, quantity) => void send({
                            request_id: crypto.randomUUID(), product_id: id,
                            message: `Confirm removal of ${quantity} from my cart`,
                          }, false, `Confirm removal of ${quantity} × ${name} from my cart`)}
                          onRemoveDestination={(query, destination, quantity) => void send({
                            request_id: crypto.randomUUID(),
                            message: query === "all items" && destination === "cart" ? "Clear my cart" : destination === "cart" ? `Remove ${quantity} ${query} from my cart` : `Remove ${query} from my wishlist`,
                          })}
                          onChooseProduct={(id, name, action, quantity) => void send({
                            request_id: crypto.randomUUID(), product_id: id,
                            message: action === "cart" ? `Add ${quantity} of this to my cart` : "Save this to my wishlist",
                          }, false, action === "cart" ? `Add ${quantity} × ${name} to my cart` : `Save ${name} to my wishlist`)}
                          onCompare={(routes, names) => void send({
                            request_id: crypto.randomUUID(), message: `Compare these products: ${routes.join(" ")}`,
                          }, false, `Compare ${names.join(" and ")}`)}
                        />}
                        {!m.blocks?.length && m.text && (m.role === "assistant" ? <AssistantMarkdown text={m.text} onCheckout={openCheckout} onSupport={() => startTicket()} /> : <p>{m.text}</p>)}
                        {i === messages.length - 1 && replyContext && !busy && <AssistantClarification key={m.requestId} context={replyContext} onReply={message => void send({ request_id: crypto.randomUUID(), message, ...selectionInput(selection), clarification: replyContext })} />}
                        {m.reorder && customer && <AssistantReorder order={m.reorder} disabled={busy} autoStart />}
                        {m.orderPicker && customer && <AssistantOrders customerId={customer.id} busy={busy} onSelect={openOrder} />}
                        {!m.blocks?.length && !m.text && !m.order && !m.ticket && pending && (
                          <div className="assistant-thinking" role="status">
                            <span />
                            <span />
                            <span />
                            <small>{progress}</small>
                          </div>
                        )}
                        {!m.blocks?.length && !m.text && !m.order && !m.orders?.length && !m.ticket && !pending && (
                          <p className="assistant-caption">
                            {m.failure ?? "Response stopped. You can retry or contact our team."}
                          </p>
                        )}
                        {(m.orders?.length ? m.orders : m.order ? [m.order] : []).map((order, orderIndex) => {
                          const header = <div className="assistant-order-label">
                            <Icon name="box" /> {m.orders && m.orders.length > 1 ? "Order history" : "Order update"}{" "}
                            <span>Verified order details</span>
                          </div>;
                          return (
                          <div className="assistant-order-card" key={`${order.id}:${orderIndex}`}>
                            {customer ? <AssistantReorder order={order} disabled={busy} header={header} /> : header}
                            <AssistantOrderDetails order={order} customerId={customer?.id} disabled={busy}>
                            <dl>
                              <div>
                                <dt>Items</dt>
                                <dd>
                                  {order.subtotal} {order.currency}
                                </dd>
                              </div>
                              <div>
                                <dt>Discount</dt>
                                <dd>{order.discount_amount}</dd>
                              </div>
                              <div>
                                <dt>Tax</dt>
                                <dd>{order.tax_amount}</dd>
                              </div>
                              <div>
                                <dt>Delivery</dt>
                                <dd>{order.delivery_fee}</dd>
                              </div>
                            </dl>
                            {order.shipments.map((s, j) => (
                              <p className="assistant-shipment" key={j}>
                                Shipment: {s.status} · Tracking:{" "}
                                {s.tracking_reference || "Not assigned yet"}
                              </p>
                            ))}
                            </AssistantOrderDetails>
                          </div>
                          );
                        })}
                        {m.ticket && <AssistantTicketCard detail={m.ticket} refreshing={ticketId === m.ticket.ticket.id && ticket.isFetching} expanded={expandedTicketId === m.ticket.ticket.id} onToggle={() => setExpandedTicketId(current => current === m.ticket!.ticket.id ? undefined : m.ticket!.ticket.id)} />}
                        {m.login && !customer && authActions}
                        {pending && m.text && (
                          <span className="assistant-streaming" role="status">
                            {progress}
                          </span>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
                {showCatalog && (
                  <CatalogShelf
                    onCompare={(routes, names) => void send({request_id: crypto.randomUUID(), message: `Compare these products: ${routes.join(" ")}`}, false, `Compare ${names.join(" and ")}`)}
                    onRecommend={() =>
                      void send({
                        request_id: crypto.randomUUID(),
                        message: "Recommend a product",
                      })
                    }
                  />
                )}
            {stopped && !busy && (
              <div className="assistant-inline-notice" role="status">
                Response stopped. Any partial answer is kept above.{" "}
                {last && <button onClick={() => void send({ ...last, request_id: crypto.randomUUID() }, true)}>Retry response</button>}
              </div>
            )}
            {error && (
              <div role="alert" className="assistant-error">
                <strong>Assistant request could not be completed</strong>
                <p>{error}</p>
                <div>
                  {last && failureDetails?.retryable !== false && (
                    <button disabled={busy} onClick={() => void send({ ...last, request_id: last.ticket ? last.request_id : crypto.randomUUID() }, true)}>
                      Retry response
                    </button>
                  )}
                  {failureDetails?.recovery === "sign_in" && authActions}
                  {failureDetails?.recovery === "browse_catalog" && <Link to="/search">Browse catalog</Link>}
                  {failureDetails?.recovery === "refresh_proposal" && <button onClick={() => void cache.invalidateQueries({ queryKey: ["shopping-task", conversationId] })}>Refresh proposal</button>}
                  <button className="text-button" onClick={() => startTicket()}>
                    Contact support
                  </button>
                </div>
              </div>
            )}
            {ticketId && customer && ticket.isPending && <div className="assistant-message assistant-message-assistant" role="status">Loading ticket details…</div>}
            {ticket.isError && (
              <div role="alert" className="assistant-error">
                <strong>Ticket tracking is unavailable</strong>
                <p>{ticket.error.message}</p>
                <div>
                  <button type="button" onClick={() => void ticket.refetch()}>Retry ticket details</button>
                </div>
              </div>
            )}
            {(checkoutStarted || (!!messages.length && !!cart?.items.length)) && <div ref={checkoutPanel} className="assistant-checkout-panel" hidden={!checkoutOpen}>
              <div id="assistant-checkout" hidden={!checkoutOpen}>
                {checkoutStarted && <Checkout customer={customer} embedded onReplyReady={registerCheckoutReply} onViewOrder={orderId => {
                  if (sending.current || (savedConversation && customer && selectedHistory.isPending)) return;
                  setCheckoutOpen(false);
                  setSelection({ kind: "order", id: orderId });
                  setDismissedClarification(latestResponse?.requestId);
                  void send({ request_id: crypto.randomUUID(), message: "Show my order details", order_id: orderId });
                }} />}
              </div>
            </div>}
            {ticketDraft && <AssistantTicketIntake ticketDraft={ticketDraft} ticketStep={ticketStep} ticketPosting={ticketPosting} ticketSubmitError={ticketSubmitError} attempted={ticketAttempted.current} busy={busy} onSubmit={createChatTicket} onCancel={() => handleTicketReply('cancel')} onCategory={category => { if (sending.current || ticketPosting) return; handleTicketReply(category); composer.current?.focus(); }} />}
            <AssistantWishlistWatcher key={`wishlist:${customer?.id ?? "guest"}:${conversationId}`} customerId={customer?.id} />
          </div>
        </div>
        <div className="assistant-composer-wrap">
          {scrolledUp && messages.length > 0 && (
            <button
              className="secondary assistant-jump"
              onClick={() => {
                follow.current = true;
                setScrolledUp(false);
                scrollToLatest(true);
              }}
            >
              ↓ Latest message
            </button>
          )}
          <div className="assistant-composer">
            <form onSubmit={submit}>
              <label className="sr-only" htmlFor="assistant-message">
                Your message
              </label>
              <textarea
                ref={composer}
                id="assistant-message"
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    !e.shiftKey &&
                    !e.nativeEvent.isComposing &&
                    window.matchMedia("(pointer: fine)").matches
                  ) {
                    e.preventDefault();
                    e.currentTarget.form?.requestSubmit();
                  }
                }}
                maxLength={4000}
                rows={1}
                placeholder={ticketDraft ? ({ subject: 'Short subject…', category: 'Choose a category below…', body: 'Describe what happened…', name: 'Your name…', contact: 'Email or mobile number…', review: 'Reply “yes” to open your ticket…' })[ticketStep] : "Ask about an order, or tell us what you need…"}
              />
              <div className="assistant-composer-bottom">
                <div className="assistant-composer-actions">
                <button type="button" className="text-button assistant-composer-shortcut" onClick={() => {
                  if (sending.current || (savedConversation && customer && selectedHistory.isPending)) return;
                  setCheckoutOpen(false);
                  setSelection(undefined);
                  setDismissedClarification(latestResponse?.requestId);
                  void send({ request_id: crypto.randomUUID(), message: "List my addresses" });
                }} disabled={busy || (!!savedConversation && !!customer && selectedHistory.isPending)}>
                  <Icon name="pin" /><span>Address</span>
                </button>
                <button type="button" className="text-button assistant-composer-shortcut" disabled={busy || (!!savedConversation && !!customer && selectedHistory.isPending)} onClick={showCart}>
                  <Icon name="bag" /><span>Cart</span>
                </button>
                <button type="button" className="text-button assistant-composer-shortcut" disabled={busy || (!!savedConversation && !!customer && selectedHistory.isPending)} onClick={() => void send({ request_id: crypto.randomUUID(), message: 'Show my wishlist' })}>
                  <Icon name="heart" /><span>Wishlist</span>
                </button>
                <button type="button" className="text-button assistant-composer-shortcut" disabled={busy || (!!savedConversation && !!customer && selectedHistory.isPending)} onClick={showOrders}>
                  <Icon name="box" /><span>Orders</span>
                </button>
                <button
                  className="text-button assistant-composer-help"
                  type="button"
                  onClick={() => startTicket()}
                >
                  <Icon name="plus" />
                  <span>Open a ticket</span>
                </button>
                {(checkoutStarted || (!!messages.length && !!cart?.items.length)) && <button type="button" className="text-button assistant-composer-checkout" aria-expanded={checkoutOpen} aria-controls="assistant-checkout" disabled={busy}
                  onClick={() => checkoutOpen ? setCheckoutOpen(false) : openCheckout()}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M5 8h14l1 13H4L5 8Z"/><path d="M8 9V6a4 4 0 0 1 8 0v3"/></svg>
                  <span>{checkoutOpen ? 'Pause checkout' : checkoutStarted ? 'Resume checkout' : 'Checkout'}</span>
                </button>}
                </div>
                {busy ? (
                  <button
                    className="assistant-send"
                    type="button"
                    aria-label="Stop response"
                    onClick={stopResponse}
                  >
                    <Icon name="stop" />
                  </button>
                ) : (
                  <button
                    className="assistant-send"
                    disabled={ticketPosting || !text.trim() || (!!savedConversation && !!customer && selectedHistory.isPending)}
                    aria-label="Send message"
                  >
                    <Icon name="arrow" />
                  </button>
                )}
              </div>
            </form>
          </div>
          <p className="assistant-footnote">
            A helping hand from Rocento.{" "}
            <button className="text-button" onClick={() => startTicket()}>
              Our team is here, too.
            </button>
          </p>
        </div>
      </section>

    </main>
    <AssistantAuth mode={authMode} onClose={() => setAuthMode(null)} onAuthenticated={account => onAuthenticated(account, [...messages, { role: "assistant", text: "You’re logged in. You can continue your request." }])} />
    </AssistantSelectionContext.Provider>
  );
}
