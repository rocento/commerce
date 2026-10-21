import { useId, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { locationAddress, orderApi } from "@commerce/api-client";
import { OrderItemImage, OrderSummary, statusName } from "./orders";
import { subtractMoney } from "./market-money";

export function AssistantOrderDetails({ order, customerId, disabled, children }: {
  order: { id: string; number: number; status: string; total: string; currency: string };
  customerId?: string;
  disabled: boolean;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const regionId = useId();
  const query = useQuery({
    queryKey: ["assistant-order-details", customerId, order.id],
    queryFn: () => orderApi.detail(order.id),
    enabled: open && !!customerId,
    retry: false,
  });
  const detail = customerId ? query.data : undefined;
  return <>
    <OrderSummary order={order} disabled={disabled} onOpen={() => setOpen(value => !value)} expanded={open} controls={regionId} />
    {open && <section id={regionId} className="assistant-order-details" aria-label={`Details for order #${order.number}`}>
      {children}
      {!customerId ? <p>Please sign in to view your order details.</p> : query.isPending ? <p role="status">Loading order details…</p> : query.isError ? <div role="alert"><p>We couldn’t load this order’s details.</p><button type="button" className="secondary" onClick={() => void query.refetch()}>Try again</button></div> : detail && <>
        <div className="assistant-order-section-heading"><h3>Ordered items</h3><span>{detail.items.length} {detail.items.length === 1 ? "product" : "products"}</span></div>
        <ul className="assistant-order-items">{detail.items.map((item, index) => <li key={`${item.product_id}:${index}`}>
          <OrderItemImage productId={item.product_id} name={item.name} />
          <div className="assistant-order-item-description"><strong>{item.name}</strong><span>{item.quantity} × {item.price} {detail.order.currency}</span></div>
          <strong>{subtractMoney(item.line_total, item.discount_amount ?? "0")} {detail.order.currency}</strong>
        </li>)}</ul>
        {!detail.items.length && <p>Item details are unavailable for this order.</p>}
        <div className="assistant-order-delivery">
        <h3>{detail.fulfillment_plan?.method === "pickup" ? "Pickup" : "Delivery"}</h3>
        <p>{locationAddress(detail.order.location) || "Address not recorded."}</p>
        <p>{[["Building", detail.order.location.building], ["Floor", detail.order.location.floor], ["Apartment", detail.order.location.apartment]].filter(([, value]) => value).map(([label, value]) => `${label} ${value}`).join(" · ")}</p>
        {detail.order.location.delivery_instructions && <p>Instructions: {detail.order.location.delivery_instructions}</p>}
        {detail.fulfillment_plan?.groups.map(group => <p key={group.id}>{group.source_name}: {group.schedule_id ? `${new Date(group.starts_at).toLocaleString([], { timeZone: group.timezone })}–${new Date(group.ends_at).toLocaleTimeString([], { timeZone: group.timezone })} (${group.timezone})` : group.method === "pickup" ? "Collect when marked ready" : "No delivery window assigned yet"}</p>)}
        {detail.shipments.length ? detail.shipments.map(({ shipment }) => <p key={shipment.id}>{shipment.method === "pickup" ? "Pickup" : "Shipment"}: {statusName(shipment.status)}{shipment.tracking_reference ? ` · Tracking: ${shipment.tracking_reference}` : " · Tracking not assigned yet"}</p>) : <p>No shipment assigned yet.</p>}
        {detail.order.gift_message && <p>Gift message: {detail.order.gift_message}</p>}
        </div>
        <Link className="assistant-order-full-link" to={`/account/orders/${order.id}`}>View full order and payment details <span className="direction-icon" aria-hidden="true">→</span></Link>
      </>}
    </section>}
  </>;
}
