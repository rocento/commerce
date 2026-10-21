import { useInterface } from './interface-locale';
import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  catalogApi,
  reviewApi,
  wishlistApi,
  type Customer,
} from "@commerce/api-client";
import { Field, Notice, useAction } from "@commerce/ui";
import { ProductCard } from "./catalog";
import { useNotification } from "./notifications";

const wishlistKey = (customer?: Customer | null) => ["wishlist", customer?.id] as const;

export function WishlistLink({ customer }: { customer: Customer | null }) {
  const { t: ui } = useInterface();
  const query = useQuery({
    queryKey: wishlistKey(customer),
    queryFn: wishlistApi.list,
    enabled: !!customer,
  });
  if (!customer) return null;
  const count = query.data?.length;
  const countLabel = count === undefined ? ui("wishlist.loading", "Wishlist loading") : ui("wishlist.saved_count", count === 1 ? "{count} saved item" : "{count} saved items", { count });
  return (
    <Link className="header-link wishlist-link header-action" to="/account/wishlist" aria-label={`${ui("navigation.wishlist", "Wishlist")}, ${countLabel}`} title={ui("navigation.wishlist", "Wishlist")}>
      <svg className="header-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/></svg>
      <span className="wishlist-count" aria-hidden="true">
        {count ?? "…"}
      </span>
    </Link>
  );
}

export function WishButton({
  id,
  customer,
  compact = false,
  minimal = false,
}: {
  id: string;
  customer: Customer | null;
  compact?: boolean;
  minimal?: boolean;
}) {
  const { message } = useInterface();
  const { t: ui } = useInterface();
  const heart = (saved = false) => <svg viewBox="0 0 24 24" width="22" height="22" fill={saved ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/></svg>;
  const iconClass = `wishlist-icon-button${minimal ? " icon-button" : ""}`;
  const location = useLocation();
  const notify = useNotification();
  const cache = useQueryClient(),
    a = useAction(),
    q = useQuery({
      queryKey: wishlistKey(customer),
      queryFn: wishlistApi.list,
      enabled: !!customer,
    });
  if (!customer) {
    const next = `${location.pathname}${location.search}`;
    return compact ? (
      <Link className={`${iconClass} wishlist-compact-link`} aria-label={ui("wishlist.sign_in", "Sign in to save to wishlist")} title={ui("wishlist.sign_in", "Sign in to save to wishlist")} to={`/login?next=${encodeURIComponent(next)}`}>{heart()}</Link>
    ) : <Link to={`/login?next=${encodeURIComponent(next)}`}>{ui("wishlist.sign_in", "Sign in to save to wishlist")}</Link>;
  }
  const saved = q.data?.includes(id);
  const key = wishlistKey(customer);
  return (
    <div className={compact ? "wishlist-control compact" : "wishlist-control"}>
      <button
        type="button"
        className={compact ? iconClass : "secondary"}
        disabled={a.busy || !q.data}
        aria-pressed={!!saved}
        aria-label={saved ? "Remove from wishlist" : "Save to wishlist"}
        title={saved ? "Remove from wishlist" : "Save to wishlist"}
        onClick={() =>
          a.run(async () => {
            const previous = cache.getQueryData<string[]>(key);
            cache.setQueryData<string[]>(key, (items = []) =>
              saved ? items.filter((item) => item !== id) : [id, ...items],
            );
            try {
              if (saved) await wishlistApi.remove(id);
              else await wishlistApi.add(id);
            } catch (error) {
              cache.setQueryData(key, previous);
              throw error;
            }
            await cache.invalidateQueries({ queryKey: key });
            notify(saved ? "Removed from your wishlist." : "Saved to your wishlist.");
          })
        }
      >
        {compact ? heart(saved) : saved ? ui("wishlist.remove_icon", "♥ Remove from wishlist") : ui("wishlist.save_icon", "♡ Save to wishlist")}
      </button>
      <Notice error>{message((a.error || q.error?.message) || '')}</Notice>
    </div>
  );
}
export function ProductReviews({
  id,
  customer,
}: {
  id: string;
  customer: Customer | null;
}) {
  const { message } = useInterface();
  const { t: ui } = useInterface();
  const [offset, setOffset] = useState(0),
    cache = useQueryClient(),
    a = useAction();
  const q = useQuery({
    queryKey: ["reviews", id, offset],
    queryFn: () => reviewApi.public(id, offset),
    refetchInterval: 10000,
  });
  const own = useQuery({
    queryKey: ["my-review", id, customer?.id],
    queryFn: () => reviewApi.own(id),
    enabled: !!customer,
  });
  return (
    <section className="product-reviews">
      <h2>{ui("storefront.customer_reviews", "Customer reviews")}</h2>
      <Notice error>{message((q.error?.message || own.error?.message || a.error) || '')}</Notice>
      <Notice>{message((a.message) || '')}</Notice>
      {q.isPending ? (
        <p>{ui("reviews.loading", "Loading reviews…")}</p>
      ) : q.data?.length === 0 ? (
        <p className="reviews-empty">{ui("reviews.empty", "No reviews yet. Be the first to share your experience.")}</p>
      ) : (
        q.data?.map((r) => (
          <article className="review-card" key={r.id}>
            <p aria-label={ui("reviews.stars","{rating} out of 5 stars",{rating:r.rating})}>
              {"★".repeat(r.rating)}
              {"☆".repeat(5 - r.rating)} · {r.display_name}
            </p>
            <h3>{r.title}</h3>
            <p>{r.body}</p>
          </article>
        ))
      )}
      {(offset > 0 || (q.data?.length ?? 0) >= 50) && (
        <nav className="reviews-pagination" aria-label={ui("reviews.pages", "Review pages")}>
          <button
            className="secondary"
            disabled={offset === 0 || q.isFetching}
            onClick={() => setOffset(offset - 50)}
          >
            {ui("reviews.previous", "Previous reviews")} </button>
          <button
            className="secondary"
            disabled={q.isFetching || (q.data?.length ?? 0) < 50}
            onClick={() => setOffset(offset + 50)}
          >
            {ui("reviews.next", "Next reviews")} </button>
        </nav>
      )}
      {customer?.verified ? (
        <form
          className="form-card review-form"
          key={own.data?.version ?? "new"}
          onSubmit={(e) => {
            e.preventDefault();
            const d = new FormData(e.currentTarget);
            void a.run(async () => {
              await reviewApi.submit(id, {
                display_name: String(d.get("display_name")),
                rating: Number(d.get("rating")),
                title: String(d.get("title")),
                body: String(d.get("body")),
              });
              await cache.invalidateQueries({ queryKey: ["my-review", id] });
              await cache.invalidateQueries({ queryKey: ["reviews", id] });
              a.setMessage(
                "Review submitted for moderation. It will appear after approval.",
              );
            });
          }}
        >
          <h3>{own.data ? ui("reviews.edit", "Edit your review") : ui("reviews.write", "Write a review")}</h3>
          {own.data && (
            <p>
              {ui("reviews.status","Status: {status}",{status:own.data.status})}
              {own.data.moderation_reason
                ? ` · ${own.data.moderation_reason}`
                : ""}
            </p>
          )}
          <p className="review-form-help">
            {ui("reviews.moderation", "Reviews are moderated. Editing an approved review sends it back for approval.")} </p>
          <Field
            label={ui("reviews.name", "Public display name")}
            name="display_name"
            required
            maxLength={80}
            defaultValue={own.data?.display_name ?? ""}
          />
          <fieldset className="rating-stars">
            <legend>{ui("reviews.rating", "Rating")}</legend>
            {[1, 2, 3, 4, 5].map((n) => (
              <label key={n}>
                <input type="radio" name="rating" value={n} defaultChecked={(own.data?.rating ?? 5) === n} />
                <span aria-hidden="true">★</span>
                <span className="sr-only">{ui("reviews.rating_value","{rating} out of 5",{rating:n})}</span>
              </label>
            ))}
          </fieldset>
          <Field
            label={ui("reviews.title", "Review title")}
            name="title"
            required
            maxLength={200}
            defaultValue={own.data?.title ?? ""}
          />
          <label className="field">
            {ui("reviews.body", "Your review")} <textarea
              rows={5}
              name="body"
              required
              maxLength={4000}
              defaultValue={own.data?.body ?? ""}
            />
          </label>
          <button disabled={a.busy || own.isPending}>
            {ui("reviews.submit", "Submit for moderation")} </button>
        </form>
      ) : (
        <p>
          {customer ? (
            <Link to="/verify">{ui("reviews.verify", "Verify your account to write a review")}</Link>
          ) : (
            <Link to="/login">{ui("reviews.sign_in", "Sign in to write a review")}</Link>
          )}
        </p>
      )}
    </section>
  );
}
function WishItem({ id, customer }: { id: string; customer: Customer }) {
  const { t: ui, locale } = useInterface();
  const q = useQuery({
    queryKey: ["wishlist-product", id, customer.id, locale],
    queryFn: () => catalogApi.product(id, locale),
  });
  if (q.data) return <ProductCard product={q.data} customer={customer} />;
  return (
    <article className="product-card">
      <p role={q.isPending ? "status" : "alert"}>
        {q.isPending ? ui("common.loading", "Loading…") : ui("wishlist.product_unavailable", "Product unavailable")}
      </p>
      {!q.isPending && <WishButton id={id} customer={customer} />}
    </article>
  );
}
export function Wishlist({ customer }: { customer: Customer | null }) {
  const { message } = useInterface();
  const { t: ui } = useInterface();
  const [offset, setOffset] = useState(0),
    q = useQuery({
      queryKey: wishlistKey(customer),
      queryFn: wishlistApi.list,
      enabled: !!customer,
    });
  useEffect(() => {
    const pageCount = Math.ceil((q.data?.length ?? 0) / 25);
    const lastPageStart = Math.max(0, pageCount - 1) * 25;
    if (offset > lastPageStart) setOffset(lastPageStart);
  }, [offset, q.data?.length]);
  return (
    <main>
      <h1>{ui("wishlist.your_wishlist", "Your wishlist")}</h1>
      {!customer ? (
        <Link to="/login">{ui("wishlist.sign_in_to_view_your_wishlist", "Sign in to view your wishlist")}</Link>
      ) : (
        <>
          <Notice error>{message((q.error?.message) || '')}</Notice>
          {q.isPending ? (
            <p>{ui("wishlist.loading_wishlist", "Loading wishlist…")}</p>
          ) : !q.data?.length ? (
            <p>{ui("wishlist.your_wishlist_is_empty_save_favorites_from_any_product_page", "Your wishlist is empty. Save favorites from any product page.")}</p>
          ) : (
            <div className="product-grid wishlist-grid">
              {q.data
                .slice(offset, offset + 25)
                .map((id) => <WishItem key={id} id={id} customer={customer} />)}
            </div>
          )}
          <button
            className="secondary"
            disabled={!offset}
            onClick={() => setOffset(offset - 25)}
          >
            {ui("storefront.previous", "Previous")} </button>{" "}
          <button
            className="secondary"
            disabled={offset + 25 >= (q.data?.length ?? 0)}
            onClick={() => setOffset(offset + 25)}
          >
            {ui("storefront.next", "Next")} </button>
        </>
      )}
    </main>
  );
}
