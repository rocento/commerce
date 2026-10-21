import { Fragment, type ReactNode } from "react";
import { Link } from "react-router-dom";

/** A bounded prose subset: no HTML, images, embeds, or executable URL schemes. */
export function safeAssistantLink(value: string): string | undefined {
  // URL parsing silently strips controls and normalizes backslashes; reject them first.
  if (/[\u0000-\u0020\u007f\\]/.test(value)) return undefined;
  if (/^\/products\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return value;
  if (["/search", "/cart", "/checkout", "/support", "/delivery-location", "/account/orders", "/account/wishlist", "/account/locations", "/account/locations/new", "/register", "/forgot-password"].includes(value)) return value;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password) return url.href;
  } catch { /* Unsupported links remain ordinary text. */ }
  return undefined;
}
function inline(text: string, onCheckout?: () => void, onSupport?: () => void): ReactNode[] {
  const parts = text.split(/(\[[^\]\n]+\]\([^\s)]+\)|`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\/products\/[0-9a-f-]{36}\b)/gi);
  return parts.map((part, i) => {
    const match = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
    const href = safeAssistantLink(match?.[2] ?? part);
    if (href === "/support" && onSupport) return <button type="button" className="text-button" key={i} onClick={onSupport}>{match?.[1] ?? "Open a support ticket"}</button>;
    if (href === "/checkout" && onCheckout) return <button type="button" className="text-button" key={i} onClick={onCheckout}>{match?.[1] ?? "Complete your order"}</button>;
    if (href) return href.startsWith("/") ? <Link key={i} to={href}>{match?.[1] ?? "View product"}</Link> : <a key={i} href={href} target="_blank" rel="noopener noreferrer">{match?.[1] ?? part}</a>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={i}>{part.slice(1, -1)}</code>;
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("*") && part.endsWith("*")) return <em key={i}>{part.slice(1, -1)}</em>;
    return <Fragment key={i}>{part}</Fragment>;
  });
}
export function AssistantMarkdown({ text, onCheckout, onSupport }: { text: string; onCheckout?: () => void; onSupport?: () => void }) {
  const renderInline = (value: string) => inline(value, onCheckout, onSupport);
  const lines = text.slice(0, 8000).split("\n");
  const blocks: ReactNode[] = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    const key = i;
    if (!line.trim()) { i++; continue; }
    if (line.startsWith("```")) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) code.push(lines[i++]);
      if (i < lines.length) i++;
      blocks.push(<pre key={key}><code>{code.join("\n")}</code></pre>);
    } else if (/^#{1,6} /.test(line)) {
      blocks.push(<h3 key={key}>{renderInline(line.replace(/^#{1,6} /, ""))}</h3>); i++;
    } else if (/^\s*(?:[-*] |\d+\. )/.test(line)) {
      const ordered = /^\s*\d+\. /.test(line);
      const pattern = ordered ? /^\s*\d+\. / : /^\s*[-*] /;
      const items: ReactNode[] = [];
      while (i < lines.length && pattern.test(lines[i])) {
        let item = lines[i++].replace(pattern, "");
        while (i < lines.length && /^ {2,}\S/.test(lines[i]) && !/^\s*(?:[-*] |\d+\. )/.test(lines[i])) item += "\n" + lines[i++].trim();
        items.push(<li key={i}>{renderInline(item)}</li>);
      }
      blocks.push(ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>);
    } else {
      const paragraph = [line]; i++;
      while (i < lines.length && lines[i].trim() && !/^(?:#{1,6} |```|\s*[-*] |\s*\d+\. )/.test(lines[i])) paragraph.push(lines[i++]);
      blocks.push(<p key={key}>{renderInline(paragraph.join("\n"))}</p>);
    }
  }
  return <div className="assistant-markdown">{blocks}</div>;
}
