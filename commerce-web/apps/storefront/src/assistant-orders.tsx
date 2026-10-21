import { AssistantReorder } from "./assistant-reorder";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ApiError, orderApi, type Order } from "@commerce/api-client";
import { Link } from "react-router-dom";

/** Only the signed-in customer's orders are loaded by the protected orders API. */
export function AssistantOrders({ customerId, busy, onSelect }: {
  customerId: string;
  busy: boolean;
  onSelect: (order: Order) => void;
}) {
  const [offset, setOffset] = useState(0);
  const orders = useQuery({
    queryKey: ["assistant-orders", customerId, offset],
    queryFn: () => orderApi.list(offset),
    retry: false,
  });
  return <section className="assistant-orders" aria-label="Your orders in chat">
    {orders.isPending ? <p role="status">Loading your orders…</p> : orders.isError ? (
      <div role="alert">
        {orders.error instanceof ApiError && orders.error.status === 401 ? (
          <p><Link to="/login">Sign in</Link> to view your orders.</p>
        ) : <><p>Your orders could not be loaded.</p><button type="button" onClick={() => void orders.refetch()}>Try again</button></>}
      </div>
    ) : orders.data.length ? (
      <ul className="assistant-order-options">{orders.data.map(order => (
        <li key={order.id}>
          <button type="button" className="secondary" disabled={busy} onClick={() => onSelect(order)} aria-label={`Show tracking for order #${order.number}`}>
            <span><strong>Order #{order.number}</strong><small>{new Date(order.created_at).toLocaleDateString()}</small></span>
            <span><strong>{order.status.replaceAll("_", " ")}</strong><small>{order.total} {order.currency}</small></span>
            <span className="assistant-order-track">Show tracking <span className="direction-icon" aria-hidden="true">→</span></span>
          </button>
          <AssistantReorder order={order} disabled={busy} />
        </li>
      ))}</ul>
    ) : <p>{offset ? "No more orders to show." : "You haven’t placed any orders yet."}</p>}
    {(offset > 0 || (orders.data?.length ?? 0) === 50) && <div className="assistant-order-pagination">
      <button type="button" disabled={busy || orders.isFetching || offset === 0} onClick={() => setOffset(value => value - 50)}>Previous orders</button>
      <button type="button" disabled={busy || orders.isFetching || orders.isError || (orders.data?.length ?? 0) < 50} onClick={() => setOffset(value => value + 50)}>More orders</button>
    </div>}
  </section>;
}
