import { useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { ApiError, deliveryKey, memoryApi, streamAssistant, type AssistantEvent, type AssistantInput, type Customer } from "@commerce/api-client";
import { useComparison } from "./comparison";
import { clearComparisonReply } from "./assistant-comparison";
import { useAssistantDelivery } from "./assistant-delivery-context";
import type { AssistantSelection } from "./assistant-selection";
import { streamFailure, assistantFailure, progressLabels, startMessages, updateMessage, type Message } from "./assistant-state";

type StreamOptions = {
  conversationId: string;
  customer: Customer | null;
  personalize: boolean;
  sending: MutableRefObject<boolean>;
  setMessages: Dispatch<SetStateAction<Message[]>>;
  setSelection: Dispatch<SetStateAction<AssistantSelection | undefined>>;
  onBegin: () => void;
  onCheckout: (requestId: string) => void;
  onSettled: () => void;
};

/** Owns one response at a time, including cancellation, retries and server handoffs. */
export function useAssistantStream({ conversationId, customer, personalize, sending, setMessages, setSelection, onBegin, onCheckout, onSettled }: StreamOptions) {
  const cache = useQueryClient();
  const comparison = useComparison();
  const delivery = useAssistantDelivery();
  const [, setParams] = useSearchParams();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [failureDetails, setFailureDetails] = useState<AssistantEvent["failure"]>();
  const [stopped, setStopped] = useState(false);
  const [progress, setProgress] = useState<string>(progressLabels.preparing);
  const [last, setLast] = useState<AssistantInput>();
  const controller = useRef<AbortController>();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);

  async function sendResponse(input: AssistantInput, retry = false, displayMessage?: string) {
    if (sending.current) return;
    sending.current = true;
    onBegin();
    const next = new AbortController();
    controller.current = next;
    const isCurrent = () => mounted.current && controller.current === next;
    const timeout = window.setTimeout(() => next.abort("timeout"), 32000);
    setBusy(true);
    setStopped(false);
    setProgress(progressLabels.preparing);
    setError("");
    setFailureDetails(undefined);
    setLast(input);
    setMessages((m) => startMessages(m, input, retry, last?.request_id, displayMessage));
    const reportFailure = (failure: string) => {
      setError(failure);
      setMessages((messages) => messages.map((message) =>
        message.role === "assistant" && message.requestId === input.request_id
          ? { ...message, failure } : message));
    };
    try {
      const memory = await memoryApi.read(conversationId, next.signal).catch(()=>null);
      if (!isCurrent()) return;
      if(memory?.enabled){try{sessionStorage.setItem(`rocento-context:${customer?.id??'guest'}`,conversationId);}catch{}}
      const confirmedOrders: NonNullable<AssistantEvent["order"]>[] = [];
      const responseProducts = new Map<string, { id: string; name: string }>();
      let responseHasCart = false;
      let comparisonClearHandled = false;
      let checkoutRequested = false;
      let responseFailed = false;
      await streamAssistant(
        { ...input, conversation_id: conversationId },
        (event) => {
          if (!isCurrent() || next.signal.aborted) return;
          if (event.type === "message.delta" && event.code === "clear_comparison") {
            if (comparisonClearHandled) return;
            comparisonClearHandled = true;
            const receipt = clearComparisonReply(comparison);
            event = { ...event, text: receipt.text };
            if (receipt.cleared) {
              setSelection(undefined);
              setParams(current => { const next = new URLSearchParams(current); next.delete("compare"); return next; }, { replace: true });
            }
          }
          if (event.code === "area_unavailable" && deliveryKey() === "none") delivery?.requestLocation();
          if (event.type === "message.delta" && event.code === "open_address_form") delivery?.requestNewAddress();
          if (event.type === "error") {
            responseFailed = true;
            setFailureDetails(event.failure);
            if (event.code === "login_required" || event.failure?.recovery === "sign_in") setMessages(current => [...current, { role: "assistant", text: "Please log in or register to continue.", login: true }]);
            reportFailure(streamFailure(event));
            return;
          }
          if (event.type === "progress" && event.stage) {
            setProgress(progressLabels[event.stage]);
            return;
          }
          if (event.type === "message.delta") setProgress("Responding…");
          if (event.type === "message.delta" && event.code === "open_checkout") checkoutRequested = true;
          if (event.type === "card.order" && event.order) confirmedOrders.push(event.order);
          if (event.type === "content.blocks") {
            for (const block of event.blocks ?? []) if (block.kind === "comparison_table") comparison?.add((block.products ?? []).map(product => product.id));
            for (const product of event.blocks?.flatMap(block => block.products ?? []) ?? []) responseProducts.set(product.id, product);
            responseHasCart ||= !!event.blocks?.some(block => block.kind === "cart_summary" || block.kind === "cart_removal");
            if (event.blocks?.some(block => block.kind === "cart_removal")) void cache.invalidateQueries({ queryKey: ["cart"] });
          }
          if (event.type === "done") {
            const domains = Number(responseHasCart) + Number(responseProducts.size > 0) + Number(confirmedOrders.length > 0);
            if (domains > 1 || responseProducts.size > 1 || confirmedOrders.length > 1) setSelection(undefined);
            else if (confirmedOrders.length === 1) {
              const order = confirmedOrders[0];
              setSelection({ kind: "order", id: order.id, number: order.number });
            } else if (responseProducts.size === 1) {
              const product = [...responseProducts.values()][0];
              setSelection({ kind: "product", id: product.id, name: product.name });
            } else if (responseHasCart) setSelection({ kind: "cart" });
            // Only a completed, validated server handoff opens checkout. Text,
            // retrieved links and restored chat history are never commands.
            if (checkoutRequested && !responseFailed) {
              checkoutRequested = false;
              setSelection(undefined);
              onCheckout(input.request_id);
            }
          }
          setMessages((m) => updateMessage(m, event));
        },
        next.signal,
        personalize,
      );
    } catch (e) {
      if (isCurrent()) {
        if (e instanceof ApiError) {
          setFailureDetails(e.failure);
          if (e.status === 401 || e.failure?.recovery === "sign_in") setMessages(current => [...current, { role: "assistant", text: "Please log in or register to continue.", login: true }]);
        }
        if (next.signal.aborted && next.signal.reason === "stopped") setStopped(true);
        else reportFailure(next.signal.reason === "timeout" ? "The response timed out. Please retry or contact support." : assistantFailure(e));
      }
    } finally {
      window.clearTimeout(timeout);
      if (controller.current === next) sending.current = false;
      if (isCurrent()) {
        setBusy(false);
        onSettled();
        void cache.invalidateQueries({ queryKey: ["cart"] });
        if (customer) void cache.invalidateQueries({ queryKey: ["wishlist", customer.id] });
        void cache.invalidateQueries({queryKey:["assistant-memory"]});
        void cache.invalidateQueries({queryKey:["saved-goals"]});
        void cache.invalidateQueries({ queryKey: ["shopping-task", conversationId] });
      }
    }
  }
  function resetStream() {
    setStopped(false);
    setError("");
    setFailureDetails(undefined);
    setLast(undefined);
  }
  const stopResponse = () => controller.current?.abort("stopped");
  return { busy, error, setError, failureDetails, stopped, progress, last, sendResponse, stopResponse, resetStream };
}
