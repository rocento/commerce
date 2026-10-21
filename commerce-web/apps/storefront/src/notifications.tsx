import { useInterface } from './interface-locale';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import "./notifications.css";

const NotificationContext = createContext<(message: string) => void>(() => {});

export const useNotification = () => useContext(NotificationContext);

export function NotificationProvider({ children }: { children: ReactNode }) {
  const {t:ui,message}=useInterface();
  const [notification, setNotification] = useState<{ message: string } | null>(null);
  const notify = useCallback((message: string) => setNotification({ message }), []);

  useEffect(() => {
    if (!notification) return;
    const timeout = window.setTimeout(() => setNotification(null), 5000);
    return () => window.clearTimeout(timeout);
  }, [notification]);

  return <NotificationContext.Provider value={notify}>
    {children}
    {typeof document !== "undefined" && createPortal(
      <div className="storefront-notifications" role="status" aria-live="polite" aria-atomic="true">
        {notification && <div className="storefront-notification">
          <span className="storefront-notification-icon" aria-hidden="true">✓</span>
          <span>{message(notification.message)}</span>
          <button type="button" aria-label={ui("common.dismiss_notification","Dismiss notification")} onClick={() => setNotification(null)}>×</button>
        </div>}
      </div>, document.body,
    )}
  </NotificationContext.Provider>;
}
