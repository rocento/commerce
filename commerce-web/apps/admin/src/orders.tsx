import { OrderStatusControl } from "./order-status-control";
import { EntityIdHeading, EntityIdCell } from "./entity-id";
import { ReasonField, orderReasonOptions } from "./reason-field";
import { RowActions } from "./row-actions";
import { locationAddress } from "@commerce/api-client";
import { PageHeader } from "./page-header";
import { OrderNotes } from "./order-notes";
import { useGrid } from "./grids";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  adminOrderApi,
  msiApi,
  fulfillmentApi,
  type AdminIdentity,
  type OrderStatus,
} from "@commerce/api-client";
import { Field, Notice, useAction } from "@commerce/ui";
const label = (s: string) => s.replaceAll("_", " ");
const money = (s: string) => "$" + Number(s).toFixed(2);
const statusTone = (status: string) =>
  ["cancelled", "delivery_failed"].includes(status)
    ? "danger"
    : ["delivered", "cash_collected"].includes(status)
      ? "success"
      : "pending";
const next: Partial<Record<OrderStatus, OrderStatus[]>> = {
  placed: ["confirmed", "cancelled"],
  confirmed: ["fulfilling", "cancelled"],
  fulfilling: ["cancelled"],
  shipped: ["delivered", "delivery_failed"],
  delivered: ["cash_collected"],
  pickup_ready: ["picked_up", "cancelled"],
  picked_up: ["cash_collected"],
};
export function AdminOrders({ who }: { who: AdminIdentity }) {
  const { id } = useParams();
  const [reason, setReason] = useState("");
  const [tracking, setTracking] = useState("");
  const [shipment, setShipment] = useState<string>();
  const [confirm, setConfirm] = useState<
    OrderStatus | "refund" | "dispatch" | null
  >(null);
  const [activeSection, setActiveSection] = useState("information");
  const a = useAction(),
    cache = useQueryClient();
  const can = (p: string) =>
    who.permissions.includes("*") || who.permissions.includes(p);
  const q = useGrid("orders", ["admin-orders"], {}, !id);
  const detail = useQuery({
    queryKey: ["admin-orders", id],
    queryFn: () => adminOrderApi.detail(id!),
    enabled: !!id,
    refetchInterval: 5000,
  });
  const d = detail.data;
  const orderContact = d
    ? d.order.contact.email || d.order.contact.mobile_number
    : "";
  const addressLine = d
    ? [
        d.order.location.building,
        d.order.location.floor && `Floor ${d.order.location.floor}`,
        d.order.location.apartment && `Apartment ${d.order.location.apartment}`,
      ]
        .filter(Boolean)
        .join(", ")
    : "";
  async function update() {
    if (!id || !confirm) return;
    await a.run(async () => {
      if (confirm === "dispatch")
        await fulfillmentApi.dispatch(id, tracking, reason, shipment);
      else if (shipment && (confirm === "delivered" || confirm === "delivery_failed")) await msiApi.shipmentStatus(shipment, confirm, reason);
      else if (confirm === "refund") await adminOrderApi.refund(id, reason);
      else await adminOrderApi.transition(id, confirm, reason);
      setConfirm(null);
      setShipment(undefined);
      setReason("");
      await cache.invalidateQueries({ queryKey: ["admin-orders"] });
      await cache.invalidateQueries({ queryKey: ["inventory"] });
    });
  }
  return (
    <main className="catalog-admin">
      <PageHeader title={<>{d ? "Order #" + d.order.number : "Orders"}</>} />
      <Notice error>
        {a.error || q.error?.message || detail.error?.message}
      </Notice>
      {!id ? (
        <>
          {q.controls}
          {q.isPending ? (
            <p>Loading orders…</p>
          ) : (
            <div className="table-wrap"><table>
              <thead>
                <tr>
                  <EntityIdHeading/><th>Order</th>
                  <th>Placed</th>
                  <th>Customer</th>
                  <th>Status</th>
                  <th>Total</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {q.data?.map((o) => (
                  <tr key={o.id}>
                    <EntityIdCell row={o}/><td>
                      <Link to={"/sales/orders/" + o.id}>#{o.number}</Link>
                    </td>
                    <td>{new Date(o.created_at).toLocaleString()}</td>
                    <td>{o.contact.email || o.contact.mobile_number}</td>
                    <td>{o.status_display?.label || label(o.status)}</td>
                    <td>{money(o.total)}</td>
                    <td>
                      <RowActions label={`order #${o.number}`} items={[{ label: "View order", to: `/sales/orders/${o.id}` }]} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
          {q.data?.length === 0 && <p>No orders yet.</p>}
        </>
      ) : (
        <>
          <Link to="/sales/orders">← All orders</Link>
          {d ? (
            <>
              <section className="order-view">
                <div className="order-titlebar">
                  <div>
                    <p className="eyebrow">ORDER VIEW</p>
                    <h2>Order #{d.order.number}</h2>
                    <p>
                      Placed {new Date(d.order.created_at).toLocaleString()} ·{" "}
                      {orderContact}
                    </p>
                  </div>
                  <div className="order-actions">
                    <span className={`order-status-label tone-${d.order.status_display?.tone || (statusTone(d.order.status) === "pending" ? "info" : statusTone(d.order.status))}`}>
                      {d.order.status_display?.label || label(d.order.status)}
                    </span>
                    {(d.order.status==="fulfilling"&&d.shipments.some(s=>s.shipment.method==="pickup") ? ["pickup_ready","cancelled"] as OrderStatus[] : next[d.order.status] || [])
                      .filter((s) =>
                        can(
                          s === "cash_collected"
                            ? "payments.collect"
                            : "orders.write",
                        ),
                      )
                      .map((s) => (
                        <button
                          key={s}
                          disabled={a.busy}
                          onClick={() => {
                            setShipment(undefined);
                            setConfirm(s);
                            setReason("");
                          }}
                        >
                          {s === "cash_collected"
                            ? "Mark cash collected"
                            : s === "cancelled"
                              ? "Cancel order"
                              : "Mark " + label(s)}
                        </button>
                      ))}
                    {d.payment.collected_at &&
                      d.refunds.length === 0 &&
                      can("payments.refund") && (
                        <button
                          className="secondary"
                          onClick={() => {
                            setConfirm("refund");
                            setReason("");
                          }}
                        >
                          Record refund
                        </button>
                      )}
                  </div>
                </div>
                <OrderStatusControl key={id} id={id!} state={d.order.status} revision={d.order.status_revision ?? 1} display={d.order.status_display} canWrite={can("orders.write")} />
                <div className="order-summary-strip">
                  <article>
                    <span>Grand total</span>
                    <strong>{money(d.order.total)}</strong>
                  </article>
                  <article>
                    <span>Payment method</span>
                    <strong>Cash on delivery</strong>
                  </article>
                  <article>
                    <span>Payment status</span>
                    <strong>
                      {d.payment.collected_at ? "Collected" : "Not collected"}
                    </strong>
                  </article>
                  <article>
                    <span>Shipments</span>
                    <strong>{d.shipments.length}</strong>
                  </article>
                </div>
                {confirm && (
                  <form
                    className="order-confirm-panel"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void update();
                    }}
                  >
                    <h3>Confirm: {label(confirm)}{shipment && ` · ${d.shipments.find(s=>s.shipment.id===shipment)?.shipment.source_name}`}</h3>
                    <p>
                      {confirm === "refund"
                        ? "Record cash already returned to the customer. This does not transfer money or restore inventory."
                        : confirm === "cancelled"
                          ? "Cancel before dispatch and return the committed units to available stock."
                          : confirm === "delivery_failed"
                            ? "Stock remains committed until staff reconcile the goods."
                            : confirm === "cash_collected"
                              ? "Confirm the full cash amount was received."
                              : "Record this operational status change."}
                    </p>
                    {confirm === "dispatch" && (
                      <Field
                        label="Tracking reference"
                        required
                        maxLength={100}
                        value={tracking}
                        onChange={(e) => setTracking(e.target.value)}
                      />
                    )}
                    <ReasonField
                      label="Reason / reference" options={orderReasonOptions(confirm)}
                      required
                      maxLength={300}
                      value={reason}
                      onValueChange={(value) => setReason(value)}
                    />
                    <button disabled={a.busy}>Confirm {label(confirm)}</button>{" "}
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => setConfirm(null)}
                    >
                      Back
                    </button>
                  </form>
                )}
              </section>
              <section className="order-detail-layout">
                <aside className="order-subnav" aria-label="Order sections">
                  {[
                    ["information", "Information"],
                    ["items", "Items Ordered"],
                    ["shipments", "Shipments"],
                    ["comments", "Comments History"],
                    ["history", "Status History"],
                  ].map(([key, title]) => (
                    <button
                      type="button"
                      key={key}
                      className={activeSection === key ? "active" : ""}
                      onClick={() => setActiveSection(key)}
                    >
                      <span>{title}</span>
                    </button>
                  ))}
                </aside>
                <div className="order-section-content">
                  {activeSection === "information" && (
                    <section className="order-info-grid">
                      <article className="order-panel">
                        <h2>Order & Account Information</h2>
                        <dl className="commerce-facts">
                          <div><dt>Order date</dt><dd>{new Date(d.order.created_at).toLocaleString()}</dd></div>
                          <div><dt>Customer</dt><dd>{orderContact}</dd></div>
                          <div><dt>Customer ID</dt><dd>{d.order.customer_id}</dd></div>
                          <div><dt>Currency</dt><dd>{d.order.currency}</dd></div>
                          {d.order.market_context&&<div><dt>Market at checkout</dt><dd>{d.order.market_context.country} · {d.order.market_context.currency}{d.order.market_context.release_id&&<small>Release {d.order.market_context.release_id}</small>}</dd></div>}
                        </dl>
                      </article>
                      <article className="order-panel">
                        <h2>Billing & Payment Information</h2>
                        <dl className="commerce-facts">
                          <div><dt>Payment method</dt><dd>Cash on delivery</dd></div>
                          <div><dt>Collection</dt><dd>{d.payment.collected_at ? `Collected ${new Date(d.payment.collected_at).toLocaleString()}` : "Cash not yet collected"}</dd></div>
                          <div><dt>Collected by</dt><dd>{d.payment.collected_by || "Not assigned"}</dd></div>
                          <div><dt>Refunds</dt><dd>{d.refunds.length ? d.refunds.map(r => `${money(r.amount)} · ${r.reason}`).join(", ") : "None"}</dd></div>
                        </dl>
                      </article>
                      <article className="order-panel">
                        <h2>Shipping Address</h2>
                        <p>{locationAddress(d.order.location)}</p>
                        {addressLine && <p>{addressLine}</p>}
                        {d.order.location.delivery_instructions && (
                          <p>{d.order.location.delivery_instructions}</p>
                        )}
                      </article>
                      <article className="order-panel">
                        <h2>Order Totals</h2>
                        <dl className="order-totals">
                          <div><dt>Subtotal</dt><dd>{money(d.order.subtotal)}</dd></div>
                          <div><dt>Delivery</dt><dd>{money(d.order.delivery_fee)}</dd></div>
                          <div><dt>Discount</dt><dd>-{money(d.order.discount_amount)}</dd></div>
                          {d.order.discount_snapshot.map((discount) => (
                            <div key={discount.rule_id}>
                              <dt>{discount.name}{discount.coupon_code ? ` (${discount.coupon_code})` : ""}</dt>
                              <dd>-{money(discount.amount)}</dd>
                            </div>
                          ))}
                          <div><dt>Tax ({d.order.tax_snapshot.name})</dt><dd>{money(d.order.tax_amount)}</dd></div>
                          <div className="grand-total"><dt>Grand total</dt><dd>{money(d.order.total)}</dd></div>
                        </dl>
                      </article>
                    </section>
                  )}
                  {activeSection === "items" && (
                    <section className="order-panel">
                      <div className="order-section-head">
                        <div>
                          <p className="eyebrow">ITEMS ORDERED</p>
                          <h2>Products</h2>
                        </div>
                        <span>{d.items.length} line items</span>
                      </div>
                      <div className="table-wrap order-items-table">
                        <table>
                          <thead>
                            <tr>
                              <th>Product</th>
                              <th>SKU</th>
                              <th>Item status</th>
                              <th>Original price</th>
                              <th>Qty</th>
                              <th>Subtotal</th>
                              <th>Discount</th>
                              <th>Row total</th>
                            </tr>
                          </thead>
                          <tbody>
                            {d.items.map((i) => (
                              <tr key={i.product_id}>
                                <td><strong>{i.name}</strong></td>
                                <td>{i.sku}</td>
                                <td>{d.order.status_display?.label || label(d.order.status)}</td>
                                <td>{money(i.price)}</td>
                                <td>{i.quantity} {i.unit}</td>
                                <td>{money(i.line_total)}</td>
                                <td>
                                  -{money(i.discount_amount)}
                                  {i.discount_snapshot.map((discount) => (
                                    <small key={discount.rule_id}>
                                      {discount.name}: -{money(discount.amount)}
                                    </small>
                                  ))}
                                </td>
                                <td>{money((Number(i.line_total) - Number(i.discount_amount)).toFixed(2))}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </section>
                  )}
                  {activeSection === "shipments" && (
                    <section className="order-panel">
                      <div className="order-section-head">
                        <div>
                          <p className="eyebrow">FULFILLMENT</p>
                          <h2>Shipments</h2>
                        </div>
                        {d.order.status !== "delivered" &&
                          !d.payment.collected_at &&
                          can("payments.collect") && (
                            <button disabled>Cash collection requires delivery</button>
                          )}
                      </div>
                      {d.scheduled_deliveries?.map(s => <article className="shipment-card" key={s.id}><h3>{s.method.replaceAll('_', ' ')}</h3><p>{new Date(s.starts_at).toLocaleString([], { timeZone: s.timezone })}–{new Date(s.ends_at).toLocaleTimeString([], { timeZone: s.timezone })} · {s.timezone}</p><p>{s.source_name} · {s.status}</p><p>Capacity: {Object.entries(s.requirement).map(([key, value]) => `${value} ${key}`).join(' · ')}</p><small>Reservation: {s.id} · Area: {s.area_id || 'Default coverage'}</small></article>)}
                      <div className="shipment-grid">
                        {d.shipments.map((dispatch) => (
                          <article className="shipment-card" key={dispatch.shipment.id}>
                            <header>
                              <div>
                                <strong>{dispatch.shipment.source_name}</strong>
                                <span className={`status-pill ${statusTone(dispatch.shipment.status)}`}>
                                  {label(dispatch.shipment.status)}
                                </span>
                              </div>
                              {dispatch.shipment.tracking_reference && (
                                <small>{dispatch.shipment.tracking_reference}</small>
                              )}
                            </header>
                            <ul>
                              {dispatch.items.map((item) => (
                                <li key={item.product_id}>
                                  {d.items.find((i) => i.product_id === item.product_id)?.name ??
                                    item.product_id}{" "}
                                  × {item.quantity}
                                </li>
                              ))}
                            </ul>
                            {dispatch.shipment.dispatched_at && (
                              <p>
                                Dispatched{" "}
                                {new Date(dispatch.shipment.dispatched_at).toLocaleString()}
                              </p>
                            )}
                            <div className="shipment-actions">
                              {dispatch.shipment.status === "pending" &&
                                ["fulfilling", "shipped"].includes(d.order.status) && dispatch.shipment.method!=="pickup" &&
                                can("fulfillment.dispatch") && (
                                  <button
                                    onClick={() => {
                                      setShipment(dispatch.shipment.id);
                                      setTracking("");
                                      setReason("");
                                      setConfirm("dispatch");
                                    }}
                                  >
                                    Dispatch
                                  </button>
                                )}
                              {dispatch.shipment.status === "shipped" &&
                                can("orders.write") &&
                                (["delivered", "delivery_failed"] as const).map((status) => (
                                  <button
                                    className="secondary"
                                    key={status}
                                    onClick={() => {
                                      setShipment(dispatch.shipment.id);
                                      setReason("");
                                      setConfirm(status);
                                    }}
                                  >
                                    Mark {label(status)}
                                  </button>
                                ))}
                            </div>
                          </article>
                        ))}
                      </div>
                    </section>
                  )}
                  {activeSection === "comments" && (
                    <OrderNotes id={d.order.id} canWrite={can("orders.write")} />
                  )}
                  {activeSection === "history" && (
                    <section className="order-panel">
                      <div className="order-section-head">
                        <div>
                          <p className="eyebrow">ORDER ACTIVITY</p>
                          <h2>Status History</h2>
                        </div>
                      </div>
                      <div className="table-wrap">
                        <table>
                          <thead>
                            <tr>
                              <th>When</th>
                              <th>Status</th>
                              <th>Actor</th>
                              <th>Reason</th>
                            </tr>
                          </thead>
                          <tbody>
                            {d.history.map((h) => (
                              <tr key={h.id}>
                                <td>{new Date(h.created_at).toLocaleString()}</td>
                                <td>{label(h.status)}</td>
                                <td>{h.actor_id || "Customer"}</td>
                                <td>{h.reason}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </section>
                  )}
                </div>
              </section>
            </>
          ) : detail.isPending ? (
            <p>Loading order…</p>
          ) : null}
        </>
      )}
    </main>
  );
}
