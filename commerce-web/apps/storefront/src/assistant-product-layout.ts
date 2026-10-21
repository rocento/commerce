import { useSyncExternalStore } from 'react';

/** Keep these viewport boundaries aligned with assistant.css. */
export function assistantProductLimit(width: number): 4 | 6 | 8 {
  return width < 768 ? 4 : width < 1024 ? 6 : 8;
}
const subscribe = (notify: () => void) => {
  window.addEventListener('resize', notify);
  return () => window.removeEventListener('resize', notify);
};
export function useAssistantProductLimit(): 4 | 6 | 8 {
  return useSyncExternalStore(subscribe, () => assistantProductLimit(window.innerWidth), () => 8);
}
