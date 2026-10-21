// Selecting support details must not remount the current conversation.
export function assistantSessionParams(params: URLSearchParams): string {
  const session = new URLSearchParams(params);
  session.delete('ticket');
  // Clearing comparison selection must not remount and erase the chat.
  session.delete('compare');
  return session.toString();
}
export function assistantTicketLink(params: URLSearchParams, id: string): string {
  const next = new URLSearchParams(params);
  next.set('ticket', id);
  return `/assistant?${next.toString()}`;
}
