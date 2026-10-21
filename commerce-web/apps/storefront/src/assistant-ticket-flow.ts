import { useRef, useState, type MutableRefObject } from "react";
import { supportApi, type Customer, type SupportDetail, type SupportInput } from "@commerce/api-client";
import { supportCategories } from "./support-logic";

type TicketFlowOptions = {
  customer: Customer | null;
  selectedOrderId?: string;
  loadingHistory: boolean;
  sending: MutableRefObject<boolean>;
  onBegin: () => void;
  focusComposer: () => void;
  ticketReply: (message: string, response: string) => void;
  onConfirmation: (message: string) => void;
  onCreated: (detail: SupportDetail) => void;
};

/** Owns ticket intake and preserves the request ID across submission retries. */
export function useAssistantTicketFlow({ customer, selectedOrderId, loadingHistory, sending, onBegin, focusComposer, ticketReply, onConfirmation, onCreated }: TicketFlowOptions) {
  const [ticketDraft, setTicketDraft] = useState<SupportInput>();
  const [ticketStep, setTicketStep] = useState<'subject' | 'category' | 'body' | 'name' | 'contact' | 'review'>('subject');
  const [ticketPosting, setTicketPosting] = useState(false);
  const [ticketSubmitError, setTicketSubmitError] = useState('');
  const ticketAttempted = useRef(false);
  function startTicket(message = 'I need to open a ticket') {
    if (sending.current || ticketPosting || loadingHistory) return;
    onBegin();
    if (ticketDraft) { focusComposer(); return; }
    setTicketDraft({ request_id: crypto.randomUUID(), subject: '', category: 'other', body: '', order_id: customer ? selectedOrderId : undefined });
    ticketAttempted.current = false; setTicketSubmitError(''); setTicketStep('subject');
    ticketReply(message, 'What do you need help with? Enter a short subject.');
    focusComposer();
  }
  async function createChatTicket() {
    if (!ticketDraft || ticketStep !== 'review' || sending.current) return;
    sending.current = true; ticketAttempted.current = true; setTicketPosting(true); setTicketSubmitError('');
    try {
      const detail = await supportApi.create(ticketDraft);
      setTicketDraft(undefined); onCreated(detail);
    } catch (error) {
      setTicketSubmitError(error instanceof Error ? error.message : 'Could not open your ticket. Retry the saved request.');
    } finally { sending.current = false; setTicketPosting(false); }
  }
  function handleTicketReply(message: string) {
    if (!ticketDraft) return false;
    const value = message.trim();
    if (/^(cancel|never mind|nevermind)$/i.test(value) && !ticketAttempted.current) {
      setTicketDraft(undefined); ticketReply(message, 'Ticket request cancelled. What else can I help with?'); return true;
    }
    if (!value) return true;
    if (ticketStep === 'subject') {
      if (value.length > 160) { ticketReply(message, 'Please keep the subject under 160 characters.'); return true; }
      setTicketDraft({ ...ticketDraft, subject: value }); setTicketStep('category');
      ticketReply(message, 'Choose a category below.');
    } else if (ticketStep === 'category') {
      const category = value.toLowerCase().replace(/[ -]+/g, '_');
      if (!supportCategories.includes(category as SupportInput['category'])) { ticketReply(message, 'Please choose order issue, product question, complaint, payment dispute, or other.'); return true; }
      setTicketDraft({ ...ticketDraft, category: category as SupportInput['category'] }); setTicketStep('body');
      ticketReply(message, 'Tell me what happened and how our team can help.');
    } else if (ticketStep === 'body') {
      if (value.length > 2000) { ticketReply(message, 'Please keep the description under 2,000 characters.'); return true; }
      setTicketDraft({ ...ticketDraft, body: value });
      setTicketStep(customer ? 'review' : 'name');
      ticketReply(message, customer ? 'Review your ticket, then select Open ticket or reply “yes”.' : 'What is your name?');
    } else if (ticketStep === 'name') {
      if (value.length > 100) { ticketReply(message, 'Please enter a name under 100 characters.'); return true; }
      setTicketDraft({ ...ticketDraft, contact_name: value }); setTicketStep('contact'); ticketReply(message, 'What is your email address or mobile number?');
    } else if (ticketStep === 'contact') {
      if (value.length > 254 || !(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) || /^\+?[\d ()-]{7,25}$/.test(value))) { ticketReply(message, 'Please enter a valid email address or mobile number, including your country code.'); return true; }
      setTicketDraft({ ...ticketDraft, contact: value }); setTicketStep('review'); ticketReply(message, 'Review your ticket, then select Open ticket or reply “yes”.');
    } else if (/^(yes|confirm|open ticket|submit|retry)$/i.test(value)) {
      onConfirmation(message);
      void createChatTicket();
    } else { ticketReply(message, ticketAttempted.current ? 'Please retry your saved ticket below so we can confirm its status.' : 'Reply “yes” to open this ticket, or “cancel” to stop.'); }
    return true;
  }
  function resetTicket() {
    setTicketDraft(undefined);
    setTicketSubmitError('');
    ticketAttempted.current = false;
  }
  return { ticketDraft, ticketStep, ticketPosting, ticketSubmitError, ticketAttempted, startTicket, createChatTicket, handleTicketReply, resetTicket };
}
