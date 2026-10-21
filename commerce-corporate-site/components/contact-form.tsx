"use client";

import { useState, type FormEvent } from "react";

export function ContactForm() {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    setBusy(true); setNotice(""); setError("");
    try {
      const response = await fetch("/api/contact", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data), signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) throw new Error(response.status === 429
        ? "Too many requests. Please wait a few minutes before trying again."
        : "We couldn't send your message. Please email info@rocento.com directly.");
      setNotice("Your message has been sent to our team. Thank you for contacting Rocento.");
      form.reset();
    } catch (e) {
      setError(e instanceof Error && e.name !== "TimeoutError" ? e.message : "Delivery could not be confirmed. Please email info@rocento.com directly.");
    } finally { setBusy(false); }
  }
  return <form className="company-contact-form" onSubmit={submit}>
    <div className="contact-fields">
      <label>Name<input name="name" autoComplete="name" required maxLength={100} /></label>
      <label>Email<input name="email" type="email" autoComplete="email" required maxLength={254} /></label>
      <label>Company <span>(optional)</span><input name="company" autoComplete="organization" maxLength={150} /></label>
      <label>How can we help?<select name="topic" defaultValue="Sales"><option>Sales</option><option>Support</option><option>Demo request</option><option>Partnership</option></select></label>
    </div>
    <label>Message<textarea name="message" required minLength={10} maxLength={5000} rows={6} /></label>
    <div className="contact-honeypot" aria-hidden="true"><label>Leave this blank<input name="website" tabIndex={-1} autoComplete="off" /></label></div>
    <p>We’ll use these details to respond to your enquiry at the email address you provide.</p>
    <button className="button primary" disabled={busy}>{busy ? "Sending…" : "Send message"}</button>
    {notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}
    <p>Prefer email? <a href="mailto:info@rocento.com">info@rocento.com</a></p>
  </form>;
}
