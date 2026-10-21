/** Exact replies to the embedded checkout's controls, not a general intent parser.
 * Longer or conditional requests stay with the assistant language engine.
 */
export type CheckoutReply = 'home' | 'work' | 'office' | 'cash' | 'confirm' | 'delivery' | 'order' | 'back';
export type CheckoutReplyHandler = (text: string) => string | null;
export type RegisterCheckoutReply = (handler: CheckoutReplyHandler | null) => void;
export function checkoutReply(text: string): CheckoutReply | null {
  const value = text.trim().toLowerCase().replace(/[.!?]+$/, '').trim();
  if (['home', 'work', 'office'].includes(value)) return value as CheckoutReply;
  const address = /^(?:use|select) my (?:saved )?(home|work|office) address$/.exec(value);
  if (address) return address[1] as CheckoutReply;
  if (['cash', 'cash on delivery', 'cash at pickup', 'pay cash on delivery', 'select cash on delivery'].includes(value)) return 'cash';
  if (['yes', 'confirm', 'continue'].includes(value)) return 'confirm';
  if (['confirm delivery', 'continue to payment'].includes(value)) return 'delivery';
  if (['confirm my order', 'confirm order'].includes(value)) return 'order';
  if (['back', 'change address', 'change delivery'].includes(value)) return 'back';
  return null;
}
