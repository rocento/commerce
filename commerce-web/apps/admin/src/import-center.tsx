import { PageHeader } from "./page-header";
import { useState } from "react";
import { CsvTools } from "./operations";

type Entity = "catalog" | "inventory";

export function ImportCenter({ canCatalog, canInventory }: { canCatalog: boolean; canInventory: boolean }) {
  const first: Entity = canCatalog ? "catalog" : "inventory";
  const [entity, setEntity] = useState<Entity>(first);
  const details = entity === "catalog"
    ? { title: "Products", description: "Create or update products by SKU, including pricing, categories, attributes, media, and status." }
    : { title: "Inventory quantities", description: "Update on-hand quantities for existing SKUs with an auditable adjustment reason." };

  return <main className="import-center">
    <p className="eyebrow">SYSTEM / DATA TRANSFER</p>
    <PageHeader title={<>Import</>} description={<>Bring commerce data into the workspace using a validated CSV file.</>} />
    <section className="import-step">
      <div className="step-number">1</div>
      <div className="import-step-content">
        <span className="eyebrow">SELECT ENTITY</span>
        <h2>What do you want to import?</h2>
        <label className="field entity-select">Entity type
          <select value={entity} onChange={e=>setEntity(e.target.value as Entity)}>
            {canCatalog && <option value="catalog">Products</option>}
            {canInventory && <option value="inventory">Inventory quantities</option>}
          </select>
        </label>
        <div className="entity-summary"><strong>{details.title}</strong><p>{details.description}</p></div>
      </div>
    </section>
    <section className="import-step">
      <div className="step-number">2</div>
      <div className="import-step-content">
        <span className="eyebrow">UPLOAD & VALIDATE</span>
        <h2>Prepare your import</h2>
        <CsvTools key={entity} kind={entity} canImport canExport={false}/>
      </div>
    </section>
  </main>;
}
