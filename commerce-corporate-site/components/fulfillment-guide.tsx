"use client";

import { useState } from "react";
import Link from "next/link";
import { DocsScreenshot } from "./docs-screenshot";

const modules = [
  {
    name: "Store policy",
    text: "Enable delivery, pickup, scheduling and routing. Store overrides replace inherited defaults.",
    location: "System → Configuration → Delivery & pickup settings",
    href: "/docs/delivery/",
    link: "Delivery and pickup configuration",
  },
  {
    name: "Locations",
    text: "Open a branch or warehouse, select its store, and configure pickup availability, instructions and preparation time. Manage product quantities separately.",
    location: "Inventory → Locations",
    href: "/docs/inventory/",
    link: "Inventory locations",
  },
  {
    name: "Stock pools",
    text: "Group locations into sellable inventory. Lower priority numbers are deducted first; default stock serves storefront carts.",
    location: "Inventory → Stock pools",
    href: "/docs/inventory/",
    link: "Stock pools and availability",
  },
  {
    name: "Inventory & replenishment",
    text: "Track on-hand, reserved and available quantities. Use replenishment to maintain stock.",
    location: "Inventory → Stock overview",
    href: "/docs/inventory/",
    link: "Inventory operations",
  },
  {
    name: "Service areas",
    text: "Choose global delivery, map boundaries or city restrictions. Global delivery uses global and default stock; schedules and capacity still apply.",
    location: "Delivery & pickup → Service areas",
    href: "/docs/delivery/",
    link: "Delivery coverage",
  },
  {
    name: "Schedules",
    text: "Set windows, timezone, lead time, cutoffs and exceptions. Delivery and pickup use separate calendars.",
    location: "Delivery & pickup → Scheduling & capacity",
    href: "/docs/delivery/",
    link: "Scheduling delivery and pickup",
  },
  {
    name: "Capacity rules",
    text: "Limit orders, items, units, weight or workload. Every matching location and shared limit applies.",
    location: "Delivery & pickup → Scheduling & capacity",
    href: "/docs/delivery/",
    link: "Capacity management",
  },
  {
    name: "Orders",
    text: "Manage confirmed orders in Sales. Inspect bookings and temporary holds in Scheduling & capacity.",
    location: "Sales → Orders",
    href: "/docs/checkout-orders/",
    link: "Checkout and orders",
  },
];

const steps = [
  {
    title: "Choose a method",
    delivery: "Enable delivery and select a delivery address.",
    pickup: "Enable pickup for the store and selected location.",
    module: "Store policy",
  },
  {
    title: "Check coverage & stock",
    delivery: "Check address coverage and available stock.",
    pickup: "Check stock at the selected pickup location.",
    module: "Locations + stock pools + inventory",
  },
  {
    title: "Build a fulfillment plan",
    delivery: "Choose a source automatically or let the customer choose. Splits require multi-source fulfillment.",
    pickup: "Use the pickup location and its preparation time.",
    module: "Store policy + inventory routing",
  },
  {
    title: "Find a time",
    delivery: "Use ASAP without a future window, or scheduling with a chosen or automatically assigned window.",
    pickup: "Use pickup calendars when scheduled pickup is enabled.",
    module: "Schedules",
  },
  {
    title: "Check operational limits",
    delivery: "When capacity is enabled, check every matching location and shared limit.",
    pickup: "When capacity is enabled, check pickup and shared limits.",
    module: "Capacity rules",
  },
  {
    title: "Review & place order",
    delivery: "Review timing and totals, then place the order.",
    pickup: "Review location, instructions and totals, then place the order.",
    module: "Checkout → Orders",
  },
];

const troubleshooting = [
  ["Pickup is not offered", "Enable pickup for both store and location. Check available stock and any required pickup windows."],
  ["An address cannot receive delivery", "Check delivery settings, coverage and stock. Without global delivery or map boundaries, an empty city list accepts saved addresses using default stock."],
  ["No time windows are available", "Check method, location, timezone, calendars, lead time, cutoffs and exceptions. Then check stock and capacity."],
  ["Stock exists but checkout cannot proceed", "Check available quantities, source assignments, routing and coverage. On-hand stock may already be reserved."],
  ["A window is full or over capacity", "Review bookings, holds and shared limits. Lowering a limit blocks new bookings without cancelling existing commitments."],
];

export function FulfillmentGuide() {
  const [method, setMethod] = useState<"delivery" | "pickup">("delivery");

  return <div className="fulfillment-guide">
    <section id="guide-flow" className="fulfillment-section">
      <div className="fulfillment-section-heading">
        <div><h2>Customer flow</h2><p>Choose a method to follow its checkout steps.</p></div>
        <div className="fulfillment-methods" role="group" aria-label="Fulfillment method">
          {(["delivery", "pickup"] as const).map(value => <button
            type="button"
            key={value}
            aria-pressed={method === value}
            aria-controls="fulfillment-flow"
            onClick={() => setMethod(value)}
          >{value === "delivery" ? "Delivery" : "Store pickup"}</button>)}
        </div>
      </div>
      <ol id="fulfillment-flow" className="fulfillment-flow" aria-label={`${method === "delivery" ? "Delivery" : "Pickup"} fulfillment flow`}>
        {steps.map((step, index) => <li key={step.title}>
          <span className="fulfillment-step-number" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
          <div><h3>{step.title}</h3><p>{step[method]}</p><small>{step.module}</small></div>
        </li>)}
      </ol>
      <DocsScreenshot name="checkout" />
      <aside className="fulfillment-note"><strong>If a check fails</strong><p>Offer another product, location, method or time. Stock, coverage and capacity must each pass.</p></aside>
    </section>

    <section id="guide-modules" className="fulfillment-section">
      <h2>Module reference</h2>
      <p>Menu locations vary by Admin version. Access depends on your role.</p>
      <div className="fulfillment-modules">
        {modules.map(module => <article key={module.name}>
          <h3>{module.name}</h3>
          <p>{module.text}</p>
          <p className="fulfillment-module-location">{module.location}</p>
          <Link href={module.href}>{module.link} <span aria-hidden="true">→</span></Link>
        </article>)}
      </div>
    </section>

    <section className="fulfillment-section fulfillment-scenarios" aria-label="Fulfillment examples">
      <article><h2>Global stock and delivery</h2><p>Global stock makes inventory available worldwide. Global delivery coverage separately enables worldwide addresses.</p></article>
      <article><h2>Split orders</h2><p>Coordinate capacity across sources. Require one shared window or allow separate windows per package.</p></article>
      <article><h2>Checkout holds</h2><p>Optional holds reserve capacity temporarily. Without holds, enabled limits are checked at order placement. A hold can expire; an order is confirmed.</p></article>
    </section>

    <section id="guide-setup" className="fulfillment-section">
      <h2>Recommended setup order</h2>
      <ol className="fulfillment-checklist">
        <li>Create locations and assign them to stock pools.</li>
        <li>Add quantities; set default stock and any global pools.</li>
        <li>Enable methods; configure coverage, routing and pickup instructions.</li>
        <li>Add calendars for scheduled delivery or pickup.</li>
        <li>Set limits; enable capacity and optional checkout holds.</li>
        <li>Test checkout. Verify the source, time, totals and order.</li>
      </ol>
      <aside className="fulfillment-note"><strong>Review changes before saving</strong><p>Saved policies apply immediately and invalidate open checkout selections. Add a change reason; review fees and tax separately.</p></aside>
    </section>

    <section id="guide-help" className="fulfillment-section">
      <h2>Troubleshooting</h2>
      {troubleshooting.map(([title, text]) => <details key={title}><summary>{title}</summary><p>{text}</p></details>)}
    </section>
  </div>;
}
