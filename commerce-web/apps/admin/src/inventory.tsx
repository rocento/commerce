import { RowActions } from "./row-actions";
import { EntityIdHeading, EntityIdCell } from "./entity-id";
import { PageHeader } from "./page-header";
import { SourceQuantities } from "./msi";
import { useGrid } from "./grids";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { inventoryApi } from "@commerce/api-client";
import { Notice, useAction } from "@commerce/ui";
export function Inventory({
  canWrite,
}: {
  canWrite: boolean;
}) {
  const [id, setId] = useState<string>();
  const a = useAction();
  const q = useGrid("inventory", ["inventory"]);
  const detail = useQuery({
    queryKey: ["inventory", "detail", id],
    queryFn: () => inventoryApi.detail(id!),
    enabled: !!id,
    refetchInterval: 3000,
  });
  return (
    <main className="catalog-admin">
      <PageHeader title={<>Inventory</>} description={<>
        Track stock on hand, reserved units, and what is available to customers.
      </>} />
      <Notice error>
        {q.error?.message || detail.error?.message || a.error}
      </Notice>
      {q.controls}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <EntityIdHeading/><th>Product</th>
              <th>SKU</th>
              <th>On hand</th>
              <th>Reserved</th>
              <th>Available</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {q.data?.map((row) => (
              <tr key={row.product_id}>
                <EntityIdCell row={row}/>
                <td>{row.name}</td>
                <td>{row.sku}</td>
                <td>{row.stock.on_hand}</td>
                <td>{row.stock.reserved}</td>
                <td>
                  <span
                    className={`badge ${row.stock.available > 0 ? "success" : ""}`}
                  >
                    {row.stock.available}
                  </span>
                </td>
                <td>
<RowActions label={row.name} items={[{label:canWrite?"View / adjust":"View inventory",onSelect:()=>setId(row.product_id)}]}/>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {detail.data && (
        <section className="catalog-editor">
          <div className="catalog-toolbar">
            <h2>{detail.data.product.name}</h2>
            <button className="secondary" onClick={() => setId(undefined)}>
              Close
            </button>
          </div>
          <p className="help">
            Stock is counted in whole selling units ({detail.data.product.unit}
            ). Active reservations cannot be removed by lowering stock.
          </p>
          <SourceQuantities productId={id!} canWrite={canWrite}/>
          <InventoryHistory id={id!}/>
        </section>
      )}
    </main>
  );
}
function InventoryHistory({id}:{id:string}) {
 const reservations=useGrid("reservations",["inventory",id,"reservations"],{product_id:id});
 const adjustments=useGrid("adjustments",["inventory",id,"adjustments"],{product_id:id});
 return <>
          <h3>Active reservations</h3>{reservations.controls}
          {(reservations.data ?? []).length === 0 ? (
            <p className="help">No active reservations.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Cart</th>
                    <th>Units</th>
                    <th>Expires</th>
                  </tr>
                </thead>
                <tbody>
                  {(reservations.data ?? []).map((r) => (
                    <tr key={r.cart_id}>
                      <td>{r.cart_id}</td>
                      <td>{r.quantity}</td>
                      <td>{new Date(r.expires_at).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <h3>Adjustment history</h3>{adjustments.controls}
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Before → After</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {(adjustments.data ?? []).map((row) => (
                  <tr key={row.id}>
                    <td>{new Date(row.created_at).toLocaleString()}</td>
                    <td>
                      {row.before_quantity} → {row.after_quantity}
                    </td>
                    <td>{row.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
 </>;
}
