import { orderStatusLabel, type OrderStatusDisplay } from "@commerce/api-client";
import { useInterface } from './interface-locale';
import { subtractMoney } from './market-money';
import { locationAddress } from "@commerce/api-client";
import { DiscountLines } from "./cart";
import { useState } from "react";
import {
  Link,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  catalogApi,
  mediaUrl,
  orderApi,
} from "@commerce/api-client";
import { Notice } from "@commerce/ui";
import "./orders.css";
const money = (value: string, currency: string) => `${value} ${currency}`;
export const statusName = (value: string) => value.replaceAll("_", " ");

export function OrderItemImage({
  productId,
  name,
}: {
  productId: string;
  name: string;
}) {
  const {t: ui, locale} = useInterface();
  const product = useQuery({
    queryKey: ["product", productId, locale],
    queryFn: () => catalogApi.product(productId, locale),
    retry: false,
  });
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const imageId = product.isError ? undefined : product.data?.media_ids[0];
  const source = imageId ? mediaUrl(imageId) : undefined;
  return (
    <span className="order-item-image">
      {source && source !== failedSource ? (
        <img
          key={source}
          src={source}
          alt={name}
          loading="lazy"
          onError={() => setFailedSource(source)}
        />
      ) : (
        <svg
          viewBox="0 0 48 48"
          role="img"
          aria-label={ui("orders.image_unavailable_for_name", "Image unavailable for {name}", {name})}
        >
          <rect x="8" y="8" width="32" height="32" rx="4" />
          <circle cx="18" cy="18" r="3" />
          <path d="m9 34 10-10 7 7 5-5 9 9" />
        </svg>
      )}
    </span>
  );
}
export function Orders() {
  const {t: ui, message} = useInterface();
  const [offset, setOffset] = useState(0);
  const q = useQuery({
    queryKey: ["orders", offset],
    queryFn: () => orderApi.list(offset),
    refetchInterval: 5000,
  });
  return (
    <main>
      <Link to="/account"><span className="direction-icon" aria-hidden="true">←</span>{ui("navigation.account", "My account")}</Link>
      <p className="eyebrow">{ui("orders.your_purchases", "YOUR PURCHASES")}</p>
      <h1>{ui("orders.your_orders", "Your orders")}</h1>
      <Notice error>{message(q.error?.message || '')}</Notice>
      {q.isPending ? (
        <p>{ui("orders.loading_orders", "Loading orders…")}</p>
      ) : q.data?.length === 0 ? (
        <p>{ui("orders.no_orders_yet", "No orders yet.")}<Link to="/search">{ui("orders.browse_groceries", "Browse groceries")}</Link>
        </p>
      ) : (
        q.data?.map((o) => <OrderSummary key={o.id} order={o} />)
      )}
      <button
        className="secondary"
        disabled={offset === 0}
        onClick={() => setOffset(offset - 50)}
      >{ui("storefront.previous", "Previous")}</button>{" "}
      <button
        className="secondary"
        disabled={!q.data || q.data.length < 50}
        onClick={() => setOffset(offset + 50)}
      >{ui("storefront.next", "Next")}</button>
    </main>
  );
}
export function OrderPage() {
  const {t: ui, message, locale} = useInterface();
  const { id } = useParams();
  const [params] = useSearchParams();
  const q = useQuery({
    queryKey: ["orders", "detail", id],
    queryFn: () => orderApi.detail(id!),
    refetchInterval: 5000,
  });
  const d = q.data;
  return (
    <main className="checkout-page">
      <Link to="/account/orders"><span className="direction-icon" aria-hidden="true">←</span>{ui("orders.your_orders", "Your orders")}</Link>
      {params.has("placed") && d?.order.status === "placed" && (
        <Notice>{ui("orders.thank_you_your_order_has_been_placed", "Thank you. Your order has been placed.")}</Notice>
      )}
      <Notice error>{message(q.error?.message || '')}</Notice>
      {d ? (
        <>
          <p className="eyebrow">{ui("orders.order_number", "Order #{number}", {number:String(d.order.number)})}</p>
          {d.order.gift_message && <p>{ui("orders.gift_message_message", "Gift message: {message}", {message:d.order.gift_message})}</p>}
          <Link to={`/assistant?order=${d.order.id}`}>{ui("orders.ask_about_this_order", "Ask about this order")}</Link>
          <h1>{orderStatusLabel(d.order.status_display, locale) || ui(`orders.status.${d.order.status}`,statusName(d.order.status))}</h1>
          <div className="checkout-review">
            <section className="form-card">
              <h2>{ui("orders.your_items", "Your items")}</h2>
              {d.items.map((i) => (
                <div className="order-line" key={i.product_id}>
                  <OrderItemImage productId={i.product_id} name={i.name} />
                  <span className="order-item-details">
                    {i.name}
                    <small>
                      {i.quantity} × {money(i.price, d.order.currency)}
                    </small>
                    {i.market_facts?.selling_rule && <small>{i.market_facts.selling_rule.measure_per_unit} {i.market_facts.selling_rule.measure_unit}{" "}{ui("orders.per_selling_unit_historical_snapshot", "per selling unit · historical snapshot")}</small>}
                    {i.market_facts ? <small>{Object.entries(i.market_facts.selected_options).map(([key,value]) => `${key}: ${String(value)}`).join(" · ")}</small> : <small>{ui("orders.legacy_order_full_option_and_pack_facts_were_not_recorded", "Legacy order: full option and pack facts were not recorded.")}</small>}
                  </span>
                  <span>
                    <strong>
                      {money(
                        subtractMoney(i.line_total,i.discount_amount ?? "0"), d.order.currency,
                      )}
                    </strong>
                    <DiscountLines items={i.discount_snapshot} currency={d.order.currency} />
                  </span>
                </div>
              ))}
              <h3>{d.fulfillment_plan?.method==='pickup'?ui("orders.pickup_location", "Pickup location"):ui("storefront.delivery_location_2", "Delivery location")}</h3>
              <p>{locationAddress(d.order.location)}</p>
              <p>
                {[
                  d.order.location.building,
                  d.order.location.floor,
                  d.order.location.apartment,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
              <p>{d.order.location.delivery_instructions}</p>
            </section>
            <aside className="form-card">
              <h2>{d.fulfillment_plan?.method==='pickup'?ui("storefront.cash_at_pickup", "Cash at pickup"):ui("checkout.cash_on_delivery", "Cash on delivery")}</h2>
              {d.order.market_context?.id&&<p>{ui("orders.market_country_currency", "Market: {country} \u00b7 {currency}", {country:d.order.market_context.country,currency:d.order.market_context.currency})}</p>}
              <p>{ui("orders.items_amount", "Items: {amount}", {amount:money(d.order.subtotal,d.order.currency)})}</p>
              <DiscountLines items={d.order.discount_snapshot} currency={d.order.currency} />
              <p>{ui("orders.delivery_amount", "Delivery: {amount}", {amount:money(d.order.delivery_fee,d.order.currency)})}</p>
              <p>
                {ui("orders.tax_name_amount", "Tax ({name}): {amount}", {name:d.order.tax_snapshot.name,amount:money(d.order.tax_amount,d.order.currency)})}
              </p>
              <h3>{ui("storefront.total", "Total:")}{money(d.order.total, d.order.currency)}</h3>
              <p>
                {d.payment.collected_at
                  ? ui("orders.cash_collected_on_date", "Cash collected on {date}", {date:new Date(d.payment.collected_at).toLocaleString(locale)})
                  : ["cancelled", "delivery_failed"].includes(d.order.status)
                    ? ui("orders.cash_has_not_been_collected", "Cash has not been collected.")
                    : ui("orders.cash_is_due_when_you_receive_your_order", "Cash is due when you receive your order.")}
              </p>
              {d.refunds.map((r) => (
                <Notice key={r.id}>
                  {ui("orders.manual_refund_recorded_amount", "Manual refund recorded: {amount}", {amount:money(r.amount,d.order.currency)})}
                </Notice>
              ))}
            </aside>
          </div>
          {d.fulfillment_plan?.groups.map(g=><section className="form-card" key={g.id}><h3>{g.source_name}</h3><p>{g.schedule_id ? `${new Date(g.starts_at).toLocaleString(locale, {timeZone:g.timezone})}–${new Date(g.ends_at).toLocaleTimeString(locale, {timeZone:g.timezone})} · ${g.timezone}` : g.method==='pickup'?ui("orders.collect_when_marked_ready", "Collect when marked ready"):ui("orders.delivery_as_soon_as_possible", "Delivery as soon as possible")}</p></section>)}
          <section className="form-card">
            {d.shipments.map((dispatch) => (
              <section key={dispatch.shipment.id} className="form-card">
                <h2>{dispatch.shipment.method==='pickup'?ui("checkout.pickup", "Pickup"):ui("orders.shipment", "Shipment")} · {dispatch.shipment.source_name}</h2>
                <p>{ui("reviews.status", "Status: {status}", {status:ui(`orders.status.${dispatch.shipment.status}`,statusName(dispatch.shipment.status))})}</p>
                {dispatch.shipment.tracking_reference && (
                  <p>{ui("orders.tracking_reference", "Tracking reference:")}{" "}
                    <strong>{dispatch.shipment.tracking_reference}</strong>
                  </p>
                )}
                <ul>
                  {dispatch.items.map((item) => (
                    <li key={item.product_id}>
                      {d.items.find((i) => i.product_id === item.product_id)
                        ?.name ?? ui("orders.order_item", "Order item")}{" "}
                      × {item.quantity}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
            <h2>{ui("orders.order_progress", "Order progress")}</h2>
            <ol>
              {d.history.map((h) => (
                <li key={h.id}>
                  <strong>{ui(`orders.status.${h.status}`,statusName(h.status))}</strong> ·{" "}
                  {new Date(h.created_at).toLocaleString(locale)}
                </li>
              ))}
            </ol>
          </section>
        </>
      ) : q.isPending ? (
        <p>{ui("orders.loading_order", "Loading order…")}</p>
      ) : null}
    </main>
  );
}

export function OrderSummary({
  order,
  onOpen,
  disabled = false,
  expanded,
  controls,
}: {
  expanded?: boolean;
  controls?: string;
  onOpen?: () => void;
  disabled?: boolean;
  order: {
    id: string;
    number: number;
    status: string;
    status_display?: OrderStatusDisplay;
    total: string;
    currency?: string;
    created_at?: string;
  };
}) {
  const {t: ui, locale} = useInterface();
  const content = (
    <>
      <div>
        <h2>{ui("orders.order_number", "Order #{number}", {number:String(order.number)})}</h2>
        {order.created_at && (
          <p>{new Date(order.created_at).toLocaleString(locale)}</p>
        )}
      </div>
      <span className="badge">{orderStatusLabel(order.status_display, locale) || ui(`orders.status.${order.status}`,statusName(order.status))}</span>
      <strong>{money(order.total, order.currency ?? ui("orders.currency_unavailable", "currency unavailable"))}</strong>
    </>
  );
  return onOpen ? (
    <button type="button" className="account-card assistant-order-open secondary" onClick={onOpen} disabled={disabled} aria-label={expanded ? ui("orders.hide_details_for_order_number_in_chat", "Hide details for order #{number} in chat", {number:String(order.number)}) : ui("orders.view_details_for_order_number_in_chat", "View details for order #{number} in chat", {number:String(order.number)})} aria-expanded={expanded} aria-controls={controls}>{content}<span className="assistant-order-details-toggle">{expanded ? ui("orders.hide_details", "Hide details \u2191") : ui("orders.details", "Details \u2193")}</span></button>
  ) : (
    <Link className="account-card" to={`/account/orders/${order.id}`}>{content}</Link>
  );
}
