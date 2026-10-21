/** Opens the checkout UI only; never confirms payment or submits an order. */
export function isCheckoutRequest(message: string): boolean {
  const text = message.normalize('NFKC').toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/\b(?:pls|plz|plase)\b/g, 'please')
    .replace(/\bcheck[ -]+out\b/g, 'checkout')
    .replace(/[.!?]+$/g, '').replace(/\s+/g, ' ').trim();
  const polite = '(?:please )?';
  const request = "(?:(?:i want to|i need to|i would like to|i'd like to|i am ready to|i'm ready to|im ready to|i wanna|can you|could you|help me|let me|let's|lets) )?";
  const action = '(?:checkout|(?:start|open|begin|resume|continue|proceed to|go to|take me to)(?: my| the)? checkout|(?:create|start|place) (?:an? |my |the )?order)';
  return new RegExp(`^${polite}${request}${polite}${action}(?: now)?(?: please)?$`).test(text);
}
