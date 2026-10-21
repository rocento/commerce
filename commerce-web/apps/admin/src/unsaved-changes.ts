import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { useBlocker, useLocation } from 'react-router-dom';

/** Mount only for the source editor; translated drafts own their own blocker. */
export function SourceEditorGuard({ dirty, leave }: { dirty: boolean; leave: { current: () => void } }) {
  const allowLeave = useUnsavedChanges(dirty);
  useLayoutEffect(() => { leave.current = allowLeave; });
  return null;
}

/** Covers links, browser history and document unload. Call allowLeave after a successful save. */
export function useUnsavedChanges(dirty: boolean) {
  const allowed = useRef(false);
  const location = useLocation();
  useEffect(() => { allowed.current = false; }, [location.key]);
  const blocker = useBlocker(useCallback(() => dirty && !allowed.current, [dirty]));
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    if (window.confirm('Discard unsaved changes and leave this page?')) blocker.proceed();
    else blocker.reset();
  }, [blocker]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      if (allowed.current) return;
      event.preventDefault(); event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  return () => { allowed.current = true; };
}
