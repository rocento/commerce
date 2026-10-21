import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, customerApi, locationAddress, type Location } from "@commerce/api-client";
import { Link } from "react-router-dom";

/** Load current addresses through the customer API, without copying them into chat history. */
export function AssistantAddresses({ customerId }: { customerId?: string }) {
  const cache = useQueryClient();
  const [deleting, setDeleting] = useState<string | null>(null);
  const removal = useMutation({
    mutationFn: customerApi.deleteLocation,
    onSuccess: async (_, id) => {
      setDeleting(null);
      const remove = (current: Location[] | undefined) => current?.filter(address => address.id !== id);
      cache.setQueryData<Location[]>(["assistant-addresses", customerId], remove);
      cache.setQueryData<Location[]>(["locations"], remove);
      await Promise.all([
        cache.invalidateQueries({ queryKey: ["assistant-addresses", customerId] }),
        cache.invalidateQueries({ queryKey: ["locations"] }),
      ]);
    },
  });
  const addresses = useQuery({
    queryKey: ["assistant-addresses", customerId],
    queryFn: customerApi.locations,
    enabled: Boolean(customerId),
    retry: false,
  });
  const signIn = !customerId || (addresses.isError && addresses.error instanceof ApiError && addresses.error.status === 401);
  return <section className="assistant-address-card" aria-label="Your saved addresses">
    <header className="assistant-address-heading"><h3>Saved addresses</h3>{!signIn && addresses.isSuccess && <span>{addresses.data.length} saved</span>}</header>
    {signIn ? <p><Link to="/login">Sign in</Link> to view your saved addresses.</p>
      : addresses.isPending ? <p role="status">Loading your saved addresses…</p>
      : addresses.isError ? <div role="alert"><p>Your saved addresses could not be loaded.</p><button type="button" className="assistant-address-retry" onClick={() => void addresses.refetch()}>Try again</button></div>
      : addresses.data.length ? <ul className="assistant-address-list">{[...addresses.data].sort((a, b) => Number(b.is_default) - Number(a.is_default)).map(address => {
        const details = [address.building && `Building ${address.building}`, address.floor && `Floor ${address.floor}`, address.apartment && `Apartment ${address.apartment}`].filter(Boolean).join(" · ");
        return <li key={address.id}>
          <div className="assistant-address-label"><h4>{address.custom_label || address.label}</h4>{address.is_default && <span>Default</span>}</div>
          <p className="assistant-address-street">{locationAddress(address)}</p>
          {details && <p className="assistant-address-details">{details}</p>}
          {address.delivery_instructions && <div className="assistant-address-instructions"><strong>Delivery instructions</strong><p>{address.delivery_instructions}</p></div>}
          {deleting === address.id ? <div className="assistant-address-confirm" role="group" aria-label={`Delete ${address.custom_label || address.label} address`}>
            <p>Delete this saved address?</p>
            {removal.isError && <p role="alert">This address could not be deleted. Please try again.</p>}
            <div className="assistant-address-actions">
              <button type="button" className="assistant-address-delete" disabled={removal.isPending} onClick={() => removal.mutate(address.id)}>{removal.isPending ? "Deleting…" : "Delete address"}</button>
              <button type="button" className="assistant-address-retry" disabled={removal.isPending} onClick={() => { setDeleting(null); removal.reset(); }}>Cancel</button>
            </div>
          </div> : <button type="button" className="assistant-address-delete" aria-label={`Delete ${address.custom_label || address.label} address`} disabled={removal.isPending} onClick={() => { removal.reset(); setDeleting(address.id); }}>Delete</button>}
        </li>;
      })}</ul> : <p>You haven’t saved any addresses yet. Add one to make checkout easier.</p>}
    {!signIn && addresses.isSuccess && !addresses.data.length && <Link className="assistant-address-manage" to="/account/locations/new">Add an address<span className="direction-icon" aria-hidden="true"> →</span></Link>}
  </section>;
}
