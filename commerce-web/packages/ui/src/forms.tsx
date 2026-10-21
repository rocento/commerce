import { useState, type ReactNode, type InputHTMLAttributes } from "react";
export function Field({
  label,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input {...props} />
    </label>
  );
}
export function Notice({
  children,
  error = false,
}: {
  children: ReactNode;
  error?: boolean;
}) {
  return children ? (
    <div
      className={`notice ${error ? "error" : ""}`}
      role={error ? "alert" : "status"}
    >
      {children}
    </div>
  ) : null;
}
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  return {
    busy,
    error,
    message,
    setError,
    setMessage,
    run: async (action: () => Promise<void>) => {
      setBusy(true);
      setError("");
      setMessage("");
      try {
        await action();
      } catch (e) {
        setError(
          e instanceof Error ? e.message : "Something went wrong. Try again.",
        );
      } finally {
        setBusy(false);
      }
    },
  };
}
