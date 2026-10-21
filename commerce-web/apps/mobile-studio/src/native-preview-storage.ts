export type PreviewTarget = 'ios' | 'android' | 'react-native-ios' | 'react-native-android';
export type SavedPreviewSession = { id: string; expiresAt: string; target: PreviewTarget };

export function isPreviewTarget(value: unknown): value is PreviewTarget {
  return typeof value === 'string' && ['ios', 'android', 'react-native-ios', 'react-native-android'].includes(value);
}

export function readPreviewSession(key: string): SavedPreviewSession | undefined {
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) || 'null');
    if (saved && typeof saved.id === 'string' && saved.id.length > 0 &&
        typeof saved.expiresAt === 'string' && Date.parse(saved.expiresAt) > Date.now() && isPreviewTarget(saved.target)) {
      return { id: saved.id, expiresAt: saved.expiresAt, target: saved.target };
    }
  } catch { /* Invalid or unavailable browser storage must not prevent previewing. */ }
  writePreviewSession(key);
}

export function writePreviewSession(key: string, session?: SavedPreviewSession) {
  try {
    if (session) sessionStorage.setItem(key, JSON.stringify({ id: session.id, expiresAt: session.expiresAt, target: session.target }));
    else sessionStorage.removeItem(key);
  } catch { /* Previewing still works if browser storage is disabled. */ }
}

export function nextPreviewInputSequence(key: string, previous: number): number {
  let stored = 0;
  try {
    const value = Number(sessionStorage.getItem(key));
    if (Number.isSafeInteger(value) && value > 0 && value < Number.MAX_SAFE_INTEGER - 1) stored = value;
  } catch { /* Use the clock and in-memory counter when storage is unavailable. */ }
  const next = Math.max(previous, stored, Date.now() * 1000) + 1;
  try { sessionStorage.setItem(key, String(next)); } catch { /* Best effort. */ }
  return next;
}
