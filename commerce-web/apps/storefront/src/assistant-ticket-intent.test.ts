import { describe, expect, it } from 'vitest';
import { isTicketRequest } from './assistant-ticket-intent';
import cases from './assistant-ticket-cases.json';

describe('1,000 customer requests to start a ticket conversation', () => {
  it('contains exactly 1,000 distinct customer phrases', () => {
    expect(cases).toHaveLength(1000);
    expect(new Set(cases.map(item => item.message)).size).toBe(1000);
  });
  it.each(cases)('$group: $message', ({ message }) => {
    expect(isTicketRequest(message)).toBe(true);
  });
});

describe('additional natural language and formatting', () => {
  it.each(['I need open ticket', 'I want open ticket', 'I need to open ticket', 'I need a ticket', 'I want a support ticket please', 'I would like a new ticket', 'OPEN A TICKET!', '  open   a ticket  ', 'Could you please open a ticket for me?', 'Hello, please create a support case.', 'I’d like to submit a service request', 'Please open a ticket on my behalf', 'Can u open a ticket plz?', 'Please open a ticket ASAP', 'open a ticket\nplease'])('recognizes %s', message => {
    expect(isTicketRequest(message)).toBe(true);
  });
});

describe('do not start intake for negation, questions, unrelated actions, or existing tickets', () => {
  const negatives = ['Do not open a ticket', "Don't open a ticket", 'dont open ticket', 'Never create a ticket', 'No ticket please', 'I do not want to open a ticket', 'I want to cancel a ticket', 'Cancel my ticket', 'Stop opening tickets', 'I already opened a ticket', 'Reopen my ticket', 'Show my tickets', 'Show my open ticket', 'Where is my ticket?', 'What is a support ticket?', 'How do I open a ticket?', 'Can you explain how to open a ticket?', 'Can you open my existing ticket?', 'Close my ticket', 'Update my ticket', 'Delete my ticket', 'Track my ticket', 'Open ticket #123', 'Open my order', 'Create a wishlist', 'Add a ticket to my cart', 'I need a bus ticket', 'I want a movie ticket', 'Open a ticket is the button label', 'My order says open ticket', 'If I open a ticket will you help?', 'I might open a ticket later', 'I wanted to open a ticket yesterday', 'I can open a ticket myself', 'Please do not connect me to support', 'Can you contact the delivery driver?', 'I need support for this product', 'The support team helped me', 'yes', 'no', 'ticket', 'support', '', 'Please open a ticket but do not submit it', 'Open a ticket instead of showing my orders'];
  it.each(negatives)('ignores %s', message => {
    expect(isTicketRequest(message)).toBe(false);
  });
  it.each(['open', 'create', 'raise', 'submit', 'file', 'start', 'make', 'log', 'lodge', 'send'])('rejects negated and instructional variants of %s', action => {
    for (const prefix of ['Do not ', "Don't ", 'Never ', 'How do I ', 'Explain how to ', 'I already tried to ']) {
      expect(isTicketRequest(`${prefix}${action} a support ticket`)).toBe(false);
    }
  });
});

// Ten request styles × ten actions × ten objects = 1,000 additional phrases.
describe('1,000 additional ways to request new ticket intake', () => {
  const prefixes = ['I need', 'I want', 'Can I', 'Could I', 'May I',
    'I want you to help me', 'Could you help me to', 'Would you help me',
    'Please I need', 'Hello I want'];
  const actions = ['open', 'create', 'raise', 'submit', 'file', 'start', 'make', 'log', 'lodge', 'send'];
  const objects = ['ticket', 'a ticket', 'a new ticket', 'a support ticket',
    'a customer support ticket', 'a customer service ticket', 'a helpdesk ticket',
    'a support case', 'a service request', 'another support ticket'];
  const messages = prefixes.flatMap(prefix => actions.flatMap(action =>
    objects.map(object => `${prefix} ${action} ${object}`)));
  it('covers 1,000 distinct phrases beyond the existing corpus', () => {
    expect(new Set(messages).size).toBe(1000);
    const existing = new Set(cases.map(item => item.message.toLowerCase()));
    expect(messages.filter(message => existing.has(message.toLowerCase()))).toEqual([]);
  });
  it.each(messages)('starts intake for %s', message => {
    expect(isTicketRequest(message)).toBe(true);
  });
  it.each([
    'I need open ticket for a concert', 'I want open ticket #123',
    'Can I open my existing ticket', 'Could I open a ticket later if needed',
    'May I ask how to open a ticket', 'I need not open ticket',
    "I don't need open ticket", 'I want to know how to open ticket',
    'I need open ticket status', 'I want open ticket history',
  ])('does not confuse other intents with intake: %s', message => {
    expect(isTicketRequest(message)).toBe(false);
  });
});
