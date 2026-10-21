import { useId, useRef, useState } from "react";
import type { AssistantBlock } from "@commerce/api-client";

type Choice = NonNullable<AssistantBlock["compound_choice"]>;

export function compoundSelectionMessage(choice: Choice, selected: string[]): string | null {
  if (choice.actions.length !== 2 || new Set(choice.actions.map(a => a.destination)).size !== 2) return null;
  const clauses: string[] = [];
  for (const [index, action] of choice.actions.entries()) {
    const sku = selected[index];
    if (!sku || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(sku)
      || !action.choices.some(product => product.sku === sku)
      || !Number.isInteger(action.quantity) || action.quantity < 1 || action.quantity > 1000000
      || !["cart", "wishlist"].includes(action.destination)
      || action.destination === "wishlist" && action.quantity !== 1) return null;
    clauses.push(`Add ${action.quantity} "${sku}" to ${action.destination}`);
  }
  return clauses.join(" then ");
}

export function AssistantCompoundChoice({ choice, busy, onConfirm }: {
  choice: Choice; busy: boolean; onConfirm?: (message: string) => void;
}) {
  const id = useId();
  const [selected, setSelected] = useState<string[]>([]);
  const [submitted, setSubmitted] = useState(false);
  const sent = useRef(false);
  const message = compoundSelectionMessage(choice, selected);
  const disabled = busy || submitted || !onConfirm;
  return <form className="assistant-compound-choice" aria-label="Choose products for both actions" onSubmit={event => {
    event.preventDefault();
    if (disabled || !message || sent.current) return;
    sent.current = true;
    setSubmitted(true);
    onConfirm?.(message);
  }}>
    {choice.actions.map((action, index) => <fieldset key={index} disabled={disabled}>
      <legend>{action.destination === "cart" ? "Add to cart" : "Save to wishlist"} · Quantity {action.quantity}</legend>
      <div className="assistant-compound-products">{action.choices.map(product => <label key={product.sku} className="assistant-compound-product">
        <input type="radio" name={`${id}-${index}`} value={product.sku} checked={selected[index] === product.sku}
          onChange={() => setSelected(current => { const next = [...current]; next[index] = product.sku; return next; })} />
        <span><strong>{product.name}</strong><small>SKU: {product.sku}</small></span>
      </label>)}</div>
    </fieldset>)}
    <p>Choose a product for each action. Availability will be checked again before making changes.</p>
    <button type="submit" disabled={disabled || !message}>{submitted ? "Request sent" : "Confirm both actions"}</button>
    {!onConfirm && <small>This selection is from an earlier response. Send a new request to continue.</small>}
  </form>;
}
