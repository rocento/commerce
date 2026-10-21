import { createContext, useContext } from "react";
import type { AssistantInput } from "@commerce/api-client";

export type AssistantSelection =
  | { kind: "order"; id: string; number?: number }
  | { kind: "product"; id: string; name: string }
  | { kind: "cart" };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function parseSelection(value: string | null): AssistantSelection | undefined {
  try {
    const selection = JSON.parse(value ?? "null");
    if (!selection || typeof selection !== "object") return;
    if (selection.kind === "cart") return { kind: "cart" };
    if (typeof selection.id !== "string" || !uuid.test(selection.id)) return;
    if (selection.kind === "order" || selection.kind === undefined) {
      return { kind: "order", id: selection.id, number: Number.isSafeInteger(selection.number) && selection.number > 0 ? selection.number : undefined };
    }
    if (selection.kind === "product" && typeof selection.name === "string" && selection.name.trim() && selection.name.length <= 1000) {
      return { kind: "product", id: selection.id, name: selection.name };
    }
  } catch { /* Ignore invalid saved browser context. */ }
}

export function selectionInput(selection?: AssistantSelection): Pick<AssistantInput, "order_id" | "product_id" | "cart_context"> {
  if (selection?.kind === "order") return { order_id: selection.id };
  if (selection?.kind === "product") return { product_id: selection.id };
  return selection?.kind === "cart" ? { cart_context: true } : {};
}

export const AssistantSelectionContext = createContext<{
  busy: boolean;
  selectProduct: (product: { id: string; name: string }) => void;
  selectCart: () => void;
  startCheckout?: () => void;
  startReorder?: (order: { id: string; number: number }) => void;
} | null>(null);
export const useAssistantSelection = () => useContext(AssistantSelectionContext);

/** Carry a target only for bounded follow-ups, never for a fresh named request. */
export function selectionForMessage(selection: AssistantSelection | undefined, message: string): AssistantSelection | undefined {
  if (!selection) return;
  const text = message.trim().toLowerCase().replace(/^(?:please|pls)\s+/, "").replace(/[\s/?.!]+$/, "");
  if (selection.kind === "product" && /^(?:price|availability|stock|details|check (?:its )?(?:price|stock)|(?:show )?(?:its|product) details|how much(?: is (?:it|this|that|this product))?|is (?:it|this|that) (?:in stock|available)|tell me about (?:it|this|that)|what is (?:it|this|that)|add(?: (?:[1-9]\d{0,6}|one|two|three|four|five|six|seven|eight|nine|ten)(?: of)?)?(?: (?:it|this|that|this product))?(?: to (?:my |the )?cart)?|remove(?: (?:[1-9]\d{0,6}|one|two|three))? (?:it|this|that)(?: from (?:my |the )?cart)?)$/.test(text)) return selection;
  if (selection.kind === "cart" && /^(?:total|how much(?: is (?:it|the total))?|how many(?: items)?(?: are (?:there|in it))?|what(?:'s| is) in (?:it|there)|(?:show|view)(?: me)? (?:it|the items)|(?:what is|what's) (?:the |its )?total)$/.test(text)) return selection;
  if (selection.kind === "order" && /^(?:where is (?:it|my order|the order)|track(?: it| my order| the order)?|(?:what is|what's) (?:its|the order) status|show (?:its|the order) details|(?:what|which) items did i (?:buy|order)|what is in (?:it|my order)|how much (?:was it|did i pay))$/.test(text)) return selection;
}
