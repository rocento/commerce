import { useEffect, useRef, type ReactNode } from "react";

type IconName =
  | "pin"
  | "heart"
  | "spark"
  | "plus"
  | "arrow"
  | "box"
  | "bag"
  | "chat"
  | "close"
  | "menu"
  | "chevron"
  | "stop"
  | "account"
  | "support";
export function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    pin: <><path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/></>,
    heart: <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/>,
    spark: (
      <>
        <path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z" />
        <path d="m20 2 .5 1.5L22 4l-1.5.5L20 6l-.5-1.5L18 4l1.5-.5Z" />
      </>
    ),
    account: <><circle cx="12" cy="8" r="4" /><path d="M4 21v-2a8 8 0 0 1 16 0v2" /></>,
    support: <><path d="M4 13v-2a8 8 0 0 1 16 0v6a4 4 0 0 1-4 4h-4" /><rect x="2" y="11" width="4" height="7" rx="2" /><rect x="18" y="11" width="4" height="7" rx="2" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    arrow: <path d="M12 19V5m-6 6 6-6 6 6" />,
    box: (
      <>
        <path d="m3 7 9-4 9 4v10l-9 4-9-4Z" />
        <path d="m3 7 9 4 9-4M12 11v10M7 5l9 4" />
      </>
    ),
    bag: (
      <>
        <path d="M5 8h14l1 13H4Z" />
        <path d="M8 9V6a4 4 0 0 1 8 0v3" />
      </>
    ),
    chat: <path d="M21 11a8 8 0 0 1-8 8H6l-4 3V11a9 9 0 0 1 19 0Z" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    menu: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="3" />
        <path d="M9 4v16" />
      </>
    ),
    chevron: <path d="m9 5 7 7-7 7" />,
    stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  };
  return (
    <svg
      className={name === "chevron" ? "direction-icon" : undefined}
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

export function Sheet({
  open,
  onClose,
  label,
  className = "",
  children,
}: {
  open: boolean;
  onClose: () => void;
  label: string;
  className?: string;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    if (!open && dialog.current?.open) dialog.current.close();
  }, [open]);
  return (
    <dialog
      ref={dialog}
      className={`assistant-sheet ${className}`}
      aria-label={label}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="assistant-sheet-body">
        <button
          className="icon-button assistant-icon-button assistant-sheet-close"
          aria-label={`Close ${label.toLowerCase()}`}
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
        {children}
      </div>
    </dialog>
  );
}

