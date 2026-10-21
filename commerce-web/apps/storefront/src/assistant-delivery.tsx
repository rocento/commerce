import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { Customer } from "@commerce/api-client";
import { DeliveryLocationPicker, LocationBar } from "./locations";
import { AssistantDeliveryContext, useAssistantDelivery } from "./assistant-delivery-context";

export function AssistantDeliveryProvider({ customer, children }: { customer: Customer | null; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [newAddress, setNewAddress] = useState(false);
  const updateListeners = useRef(new Set<(message: string, locationId?: string) => void>());
  const subscribeToUpdates = useCallback((listener: (message: string, locationId?: string) => void) => {
    updateListeners.current.add(listener);
    return () => { updateListeners.current.delete(listener); };
  }, []);
  const dialog = useRef<HTMLDialogElement>(null);
  const requestLocation = useCallback(() => { setNewAddress(false); setOpen(true); }, []);
  const requestNewAddress = useCallback(() => { setNewAddress(true); setOpen(true); }, []);
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    if (!open && dialog.current?.open) dialog.current.close();
  }, [open]);
  return <AssistantDeliveryContext.Provider value={{ requestLocation, requestNewAddress, subscribeToUpdates }}>
    {children}
    <dialog ref={dialog} className="assistant-delivery-dialog" aria-label={newAddress ? "Add a new delivery address" : "My addresses"} onCancel={() => setOpen(false)} onClose={() => setOpen(false)} onClick={event => { if (event.target === event.currentTarget) setOpen(false); }}>
      <div className="assistant-delivery-dialog-body">
        <button type="button" className="assistant-delivery-close" aria-label="Close delivery address picker" onClick={() => setOpen(false)}>×</button>
        <button type="button" className="text-button" onClick={() => setNewAddress(!newAddress)}>{newAddress ? "My addresses" : "+ New address"}</button>
        {open && <DeliveryLocationPicker key={newAddress ? "new" : "choose"} newAddress={newAddress} savedOnly customer={customer} onCancel={() => setOpen(false)} onComplete={(locationId) => {
          setOpen(false);
          for (const listener of updateListeners.current) listener("Delivery location updated. Product availability has been refreshed. You can continue shopping.", locationId);
        }} />}
      </div>
    </dialog>
  </AssistantDeliveryContext.Provider>;
}

export function AssistantDeliveryButton({ customer }: { customer: Customer | null }) {
  const delivery = useAssistantDelivery();
  return <LocationBar customer={customer} onChooseLocation={delivery?.requestLocation} />;
}
