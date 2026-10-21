/** Recognize a request to start support intake, never permission to submit a ticket. */
export function isTicketRequest(message: string): boolean {
  const text = message.normalize('NFKC').toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/\b(?:pls|plz|plsz)\b/g, 'please')
    .replace(/\bu\b/g, 'you')
    .replace(/\b(?:tiket|tickt|tcket|ticekt|tikcet|tickett|tickettt)\b/g, 'ticket')
    .replace(/\b(?:opne|opn|oppen)\b/g, 'open')
    .replace(/\b(?:creat|craete)\b/g, 'create')
    .replace(/\b(?:suport|suppport)\b/g, 'support')
    .replace(/[.!?,;:]+/g, ' ').replace(/\s+/g, ' ').trim();

  // Questions about the feature, negation, and existing-ticket actions are not intake requests.
  if (/\b(?:not|no|never|don't|dont|do not|can't|cannot|won't|wouldn't|shouldn't|cancel|stop|avoid|without|instead|already|existing|reopen|re-open)\b/.test(text)) return false;
  const greeting = '(?:(?:hi|hello|hey)(?: there)? )?';
  const polite = '(?:please |kindly )?';
  const request = "(?:(?:i (?:need|want)(?: to)?|i (?:would like|would love|wish) to|i'd like to|i wanna|i gotta|can i|could i|may i|can you|could you|would you|will you|can you help me|could you help me|help me(?: to)?|i need you to|i want you to|i need help to|i need help with|i want you to help me|could you help me to|would you help me|let me|let's) )?";
  const action = '(?:open|create|raise|submit|file|start|make|log|lodge|send)';
  const object = '(?:(?:a|an|one|new|another|a new|an additional|my) )?(?:support |customer support |customer service |help |helpdesk |service )?(?:ticket|case|request)';
  const tail = '(?: for me| on my behalf)?(?: please| thanks| thank you| now| today| asap| right now)?';
  const ticket = new RegExp(`^${greeting}${polite}${request}${polite}${action} ${object}${tail}$`);
  if (ticket.test(text)) return true;
  // Natural requests that omit an explicit creation verb.
  if (/^(?:(?:hi|hello|hey) )?(?:please )?i (?:need|want|would like|'d like) (?:a |a new |one )?(?:support |customer support |helpdesk )?ticket(?: please| now| asap| thanks)?$/.test(text)) return true;
  // A human-support handoff starts the same conversation, with review before submission.
  return /^(?:(?:hi|hello|hey) )?(?:please )?(?:connect me to|put me in touch with|let me talk to|let me speak to|i need to talk to|i want to speak to|i would like to contact|can i speak to|could i talk to|please get me) (?:support|customer support|customer service|the support team|your support team|a support agent|a human agent|a customer service agent|a support representative|someone from support)(?: please| now| thanks| thank you)?$/.test(text);
}
