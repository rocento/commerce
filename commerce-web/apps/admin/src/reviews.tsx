import { EntityIdLabel } from "./entity-id";
import { ReasonField, reasonOptions } from "./reason-field";
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { catalogApi, reviewApi, type Review } from "@commerce/api-client";
import { Notice, useAction } from "@commerce/ui";
import { PageHeader } from "./page-header";
import { useGrid } from "./grids";
import "./reviews.css";

function ReviewDate({ value }: { value: string }) {
  const date = new Date(value);
  return <time dateTime={value}>{Number.isNaN(date.getTime()) ? "Date unavailable" : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</time>;
}
function Status({ value }: { value: Review["status"] }) {
  return <span className={`review-status review-status--${value}`}>{value === "approved" ? "Published" : value === "pending" ? "Pending" : "Rejected"}</span>;
}
function ProductName({ id }: { id: string }) {
  const product = useQuery({ queryKey: ["review-product", id], queryFn: () => catalogApi.product(id), retry: false, staleTime: 60_000 });
  return <div className="review-product"><span>Product</span>{product.isPending ? <p>Loading product…</p> : product.data ? <p><strong>{product.data.name}</strong><small>SKU: {product.data.sku}</small></p> : <p>Product details unavailable <button type="button" className="text-button" onClick={() => void product.refetch()}>Retry</button><small>{id}</small></p>}</div>;
}
function Decision({ review, onClose, onSaved }: { review: Review; onClose: () => void; onSaved: (status: string) => Promise<void> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const lock = useRef(false);
  const [reason, setReason] = useState("");
  const action = useAction();
  useEffect(() => { const node = dialog.current!; node.showModal(); return () => node.close(); }, []);
  async function decide(status: "approved" | "rejected") {
    if (lock.current || !reason.trim()) return;
    lock.current = true;
    await action.run(async () => {
      await reviewApi.moderate(review.id, { status, reason: reason.trim(), expected_version: review.version });
      await onSaved(status);
    });
    lock.current = false;
  }
  return <dialog ref={dialog} className="review-dialog" aria-labelledby="review-decision-title" onCancel={e => { e.preventDefault(); if (!lock.current) onClose(); }}>
    <header><h2 id="review-decision-title">Review decision</h2><Status value={review.status} /></header>
    <p><strong>{review.title || "Untitled review"}</strong> · {review.display_name} · {review.rating}/5</p>
    <div className="review-dialog-body">{review.body}</div>
    {review.moderation_reason && <p>Previous reason: {review.moderation_reason}</p>}
    <Notice error>{action.error}</Notice>
    {action.error && <p>Your decision was not confirmed. Close this dialog and refresh the list before retrying if another moderator changed this review.</p>}
    <ReasonField label="Decision reason (visible to the customer)" options={reasonOptions.review} value={reason} onValueChange={setReason} disabled={action.busy} />
    <p className="review-muted">Choose the reason matching your decision, or select Other to explain. {reason.length}/300 characters.</p>
    <p className="review-muted">Approving publishes the review. Rejecting removes it from public product reviews.</p>
    <footer><button disabled={action.busy || !reason.trim() || review.status === "approved"} onClick={() => void decide("approved")}>Approve and publish</button><button className="secondary danger" disabled={action.busy || !reason.trim() || review.status === "rejected"} onClick={() => void decide("rejected")}>Reject review</button><button className="text-button" disabled={action.busy} onClick={onClose}>Cancel</button></footer>
    {action.busy && <p role="status">Saving decision…</p>}
  </dialog>;
}
export function Reviews({ canModerate }: { canModerate: boolean }) {
  const [selected, setSelected] = useState<Review>();
  const [message, setMessage] = useState("");
  const cache = useQueryClient();
  // The grid is the data source; no status filter is selected on first visit.
  const q = useGrid("reviews", ["review-queue"]);
  return <main className="catalog-admin reviews-admin">
    <PageHeader title="Review moderation" description="Manage customer feedback, review product ratings, and publish clear, consistent moderation decisions." />
    <div className="review-guidance"><strong>{canModerate ? "Customer feedback" : "Read-only access"}</strong><span>{canModerate ? "All statuses are included until you choose a filter. Decision reasons are visible to customers." : "You can browse reviews. Moderation requires additional permission."}</span></div>
    <Notice>{message}</Notice>
    {q.controls}
    {q.isPending ? <div className="review-empty" role="status">Loading customer reviews…</div> : q.error ? <div className="review-empty" role="alert"><h2>Reviews could not be loaded</h2><p>{q.error.message}</p><button onClick={() => void q.refetch()}>Retry loading reviews</button></div> : !q.data?.length ? <div className="review-empty"><h2>No reviews to display</h2><p>New customer reviews will appear here. If you applied filters, clear them to see all reviews.</p></div> : <div className="review-list" aria-label="Customer reviews">{q.data.map(review => <article className="review-card" key={review.id}>
      <header><div><div className="review-rating" aria-label={`${review.rating} out of 5 stars`}><span aria-hidden="true">{"★".repeat(review.rating)}{"☆".repeat(5-review.rating)}</span> <strong>{review.rating}/5</strong></div><h2>{review.title || "Untitled review"}</h2><p className="review-muted">{review.display_name} · Submitted <ReviewDate value={review.created_at} /></p></div><Status value={review.status} /></header>
      <p className="review-body">{review.body}</p><ProductName id={review.product_id} />
      {review.moderation_reason && <div className="review-reason"><strong>Decision reason</strong><p>{review.moderation_reason}</p></div>}
      <footer><div className="review-muted">Updated <ReviewDate value={review.updated_at} /><EntityIdLabel row={review}/></div>{canModerate && <button className="secondary" onClick={() => { setMessage(""); setSelected(review); }}>Review decision</button>}</footer>
    </article>)}</div>}
    {canModerate && selected && <Decision review={selected} onClose={() => setSelected(undefined)} onSaved={async status => { setSelected(undefined); setMessage(status === "approved" ? "Review approved and published." : "Review rejected."); await cache.invalidateQueries({ queryKey: ["review-queue"] }); }} />}
  </main>;
}
