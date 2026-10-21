import { PageHeader } from "./page-header";
import { useState } from "react";
import { ExportTools } from "./grids";

export type ExportEntity = { value:string; label:string; description:string };

export function ExportCenter({ entities }: { entities: ExportEntity[] }) {
  const [entity, setEntity] = useState(entities[0]?.value ?? "catalog");
  const selected = entities.find(item=>item.value===entity) ?? entities[0];
  return <main className="import-center export-center">
    <p className="eyebrow">SYSTEM / DATA TRANSFER</p>
    <PageHeader title={<>Export</>} description={<>Create downloadable datasets without interrupting your workspace.</>} />
    <section className="import-step"><div className="step-number">1</div><div className="import-step-content">
      <span className="eyebrow">SELECT ENTITY</span><h2>What do you want to export?</h2>
      <label className="field entity-select">Entity type<select value={entity} onChange={e=>setEntity(e.target.value)}>{entities.map(item=><option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
      {selected && <div className="entity-summary"><strong>{selected.label}</strong><p>{selected.description}</p></div>}
    </div></section>
    <section className="import-step"><div className="step-number">2</div><div className="import-step-content">
      <span className="eyebrow">CONFIGURE EXPORT</span><h2>Choose file format and columns</h2>
      <ExportTools key={entity} grid={entity}/>
    </div></section>
  </main>;
}
