import { useId, useState } from "react";
import "./reason-field.css";

export const reasonOptions = {
  inventory: ["Stock count correction", "New stock received", "Damaged or expired stock", "Customer return", "Stock transfer", "Stock availability update"],
  catalogImport: ["Initial catalog setup", "Supplier catalog update", "Product information correction", "Seasonal catalog update"],
  inventoryImport: ["Initial inventory setup", "Stock count reconciliation", "Supplier replenishment", "Warehouse stock update"],
  bulk: ["Seasonal promotion", "Price correction", "Supplier cost change", "Catalog reorganization", "Product availability update"],
  fee: ["Carrier rate change", "Delivery cost adjustment", "Promotional delivery pricing", "Pricing correction"],
  store: ["New store launch", "New branch opening", "Service area expansion", "Store migration"],
  location: ["Connect fulfillment location", "Pickup availability change", "Pickup instructions update", "Preparation time adjustment"],
  policy: ["Delivery coverage change", "Fulfillment method change", "Routing policy update", "Capacity management update", "Operational policy correction", "Restore inherited defaults"],
  schedule: ["New fulfillment schedule", "Operating hours change", "Holiday or temporary closure", "Lead time or cutoff adjustment", "Delivery window update", "Schedule correction"],
  capacity: ["Initial capacity setup", "Staffing change", "Vehicle or storage capacity change", "Seasonal demand adjustment", "Temporary capacity restriction", "Capacity correction"],
  enableControls: ["Start capacity management", "Resume normal operations", "Protect fulfillment capacity"],
  disableControls: ["Temporary operational exception", "Capacity configuration maintenance", "Suspend capacity management"],
  review: ["Your review meets our publication guidelines.", "Your review contains spam or promotional content.", "Your review contains inappropriate language.", "Your review contains personal information.", "Your review is unrelated to this product.", "Your review duplicates an existing submission."],
} as const;

const orderReasons: Record<string, readonly string[]> = {
  confirmed: ["Order details verified", "Payment verified", "Customer confirmed order"],
  fulfilling: ["Stock allocated and preparation started", "Warehouse processing started"],
  cancelled: ["Customer requested cancellation", "Item unavailable", "Payment not received", "Duplicate order", "Delivery address outside service area", "Suspected fraudulent order"],
  dispatch: ["Handed over to carrier", "Dispatched with delivery driver", "Replacement shipment dispatched"],
  delivered: ["Delivery confirmed by carrier", "Customer confirmed receipt", "Proof of delivery verified"],
  delivery_failed: ["Customer unavailable", "Incorrect or incomplete address", "Customer refused delivery", "Unable to contact customer", "Carrier delay or vehicle issue", "Shipment damaged in transit"],
  refund: ["Customer return", "Order cancelled", "Damaged or defective item", "Incorrect item supplied", "Order not delivered", "Duplicate payment", "Goodwill refund"],
  cash_collected: ["Cash received by delivery driver", "Cash received at pickup", "Cash collection reconciled"],
  pickup_ready: ["Order packed and ready for collection", "Transferred to pickup location"],
  picked_up: ["Collected by customer", "Collected by authorized recipient"],
};
export function orderReasonOptions(action: string): readonly string[] {
  return orderReasons[action] ?? [];
}

type Props = {
  label: string;
  options: readonly string[];
  value?: string;
  onValueChange?: (value: string) => void;
  name?: string;
  disabled?: boolean;
  required?: boolean;
  maxLength?: number;
  className?: string;
};

/** Submit the readable reason through the existing audit API, including custom reasons. */
export function ReasonField({ label, options, value: controlled, onValueChange, name, disabled, required = true, maxLength = 300, className = "field" }: Props) {
  const id = useId();
  const [local, setLocal] = useState("");
  const [other, setOther] = useState(false);
  const value = controlled ?? local;
  const custom = other || (!!value && !options.includes(value));
  function change(next: string) {
    setLocal(next);
    onValueChange?.(next);
  }
  return <div className={`${className} reason-field`}>
    <label htmlFor={id}>{label}</label>
    <select id={id} required={required} disabled={disabled} value={custom ? "__other" : value} onChange={e => {
      const isOther = e.target.value === "__other";
      setOther(isOther);
      change(isOther ? "" : e.target.value);
    }}>
      <option value="">Select a reason</option>
      {options.map(option => <option key={option} value={option}>{option}</option>)}
      <option value="__other">Other (please specify)</option>
    </select>
    {custom && <><label htmlFor={`${id}-details`}>Custom reason</label><textarea id={`${id}-details`} required={required} maxLength={maxLength} rows={3} disabled={disabled} value={value} placeholder="Explain the reason" onChange={e => {
      e.target.setCustomValidity(required && !e.target.value.trim() ? "Enter a reason." : "");
      change(e.target.value);
    }} /></>}
    {name && <input type="hidden" name={name} value={value.trim()} disabled={disabled} />}
  </div>;
}
