import { useGrid } from "./grids";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { attributeApi } from "@commerce/api-client";
import { Notice, useAction } from "@commerce/ui";
export function OrderNotes({
  id,
  canWrite,
}: {
  id: string;
  canWrite: boolean;
}) {
  const q = useGrid(
      "order-comments",
      ["order-notes", id],
      { order_id: id },
    ),
    info = useQuery({
      queryKey: ["order-extensions", id],
      queryFn: () => attributeApi.adminOrder(id),
    }),
    [body, setBody] = useState(""),
    a = useAction(),
    cache = useQueryClient();
  return (
    <section className="form-card">
      <h2>Order details & internal notes</h2>
      <p>Commerce state: {info.data?.state ?? "Loading…"}</p>
      {info.data?.gift_message && <p>Gift message: {info.data.gift_message}</p>}
      <Notice error>
        {q.error?.message || info.error?.message || a.error}
      </Notice>
      {q.controls}
      {q.data?.map((n) => (
        <article key={n.id}>
          <small>{new Date(n.created_at).toLocaleString()}</small>
          <p style={{ whiteSpace: "pre-wrap" }}>{n.body}</p>
        </article>
      ))}
      {canWrite && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void a.run(async () => {
              await attributeApi.comment(id, body);
              setBody("");
              await cache.invalidateQueries({ queryKey: ["order-notes", id] });
            });
          }}
        >
          <label className="field">
            Internal note (not visible to the customer)
            <textarea
              required
              maxLength={4000}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </label>
          <button disabled={a.busy || !body.trim()}>Add internal note</button>
        </form>
      )}
    </section>
  );
}
