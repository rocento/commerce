"use client";

import { useState } from "react";

export type ProviderHost = {
  id: string; provider: string; reference: string | null; state: string;
  address: string | null; error: string | null; updatedAt: string;
  usedSlots: number; maxSlots: number;
};
const providers = { aws: "AWS", gcp: "Google Cloud", hetzner: "Hetzner" };
const accepting = new Set(["REQUESTED", "CREATING", "BOOTING", "READY"]);
const label = (value: string) => value.toLowerCase().replaceAll("_", " ");

export function ProviderInventory({ hosts, refresh }: {
  hosts?: ProviderHost[]; refresh: () => Promise<void>;
}) {
  const [provider, setProvider] = useState("");
  const [search, setSearch] = useState("");
  const [state, setState] = useState("");
  const [loading, setLoading] = useState(false);
  const inventory = hosts ?? [];
  const visible = inventory.filter(host => (!provider || host.provider === provider)
    && (!state || host.state === state)
    && [host.id, host.reference, host.address].some(value => value?.toLowerCase().includes(search.trim().toLowerCase())));
  async function reload() {
    setLoading(true);
    try { await refresh(); } finally { setLoading(false); }
  }

  return <section className="panel" aria-labelledby="provider-title">
    <div className="panel-heading">
      <div><p className="eyebrow">CLOUD INFRASTRUCTURE</p><h2 id="provider-title">Provider data</h2>
        <p>Controller-recorded servers and reserved client slots. Refresh retrieves the latest saved data, not a live cloud API scan.</p></div>
      <button className="secondary" disabled={loading} onClick={() => void reload()}>{loading ? "Fetching provider data…" : "Refresh provider data"}</button>
    </div>
    {hosts === undefined ? <p role="status">Provider inventory is unavailable. Refresh after the operations API has been updated.</p> : <>
      <div className="provider-cards">{Object.entries(providers).map(([key, name]) => {
        const group = inventory.filter(host => host.provider === key);
        const available = group.filter(host => accepting.has(host.state)).reduce((sum, host) => sum + Math.max(0, host.maxSlots - host.usedSlots), 0);
        return <button key={key} className="provider-card" aria-pressed={provider === key} onClick={() => setProvider(provider === key ? "" : key)}>
          <strong>{name}</strong><span>{group.length} servers · {group.filter(host => host.state === "READY").length} ready</span>
          <span>{available} unreserved slots</span>
          <small>{group.length ? `${group.filter(host => host.state === "FAILED").length} failed servers` : "No recorded servers"}</small>
        </button>;
      })}</div>
      <p className="hint">Unreserved slots include servers still starting. Placement also requires a matching release and profile. Suspended and archived stores retain their slots.</p>
      <div className="provider-filters">
        <label>Filter provider<select value={provider} onChange={event => setProvider(event.target.value)}><option value="">All providers</option>{Object.entries(providers).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label>
        <label>Server status<select value={state} onChange={event => setState(event.target.value)}><option value="">All statuses</option>{["REQUESTED", "CREATING", "BOOTING", "READY", "FAILED", "DRAINING"].map(value => <option key={value} value={value}>{label(value)}</option>)}</select></label>
        <label>Search servers<input value={search} onChange={event => setSearch(event.target.value)} placeholder="Server ID, provider reference or IP"/></label>
      </div>
      <div className="table-scroll"><table aria-label="Provider servers"><thead><tr><th>Provider / server</th><th>Status</th><th>Client slots</th><th>Address</th><th>Controller updated</th><th>Details</th></tr></thead>
        <tbody>{visible.map(host => <tr key={host.id}>
          <td><strong>{providers[host.provider as keyof typeof providers] ?? host.provider}</strong>{host.reference || "Reference pending"}<small className="mono">{host.id}</small></td>
          <td><span className={`badge ${host.state.toLowerCase()}`}>{label(host.state)}</span></td>
          <td>{host.usedSlots} / {host.maxSlots}<small>{!accepting.has(host.state) ? "Not accepting placements" : host.usedSlots >= host.maxSlots ? "Full" : "Capacity available"}</small></td>
          <td>{host.address || "Not assigned"}</td><td>{host.updatedAt ? new Date(host.updatedAt).toLocaleString() : "—"}</td>
          <td>{host.error ? label(host.error) : "No reported error"}</td>
        </tr>)}</tbody></table></div>
      {!visible.length && <p className="empty">{inventory.length ? "No servers match these filters." : "No provider servers have been recorded yet. Select hosting in Store details to prepare a store for provisioning."}</p>}
    </>}
  </section>;
}
