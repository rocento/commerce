import { EntityIdHeading, EntityIdCell } from "./entity-id";
import { RowActions } from "./row-actions";
import { locationAddress } from "@commerce/api-client";
import { useState } from "react";
import { PageHeader } from "./page-header";
import { useGrid } from "./grids";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { adminCustomerApi } from "@commerce/api-client";
import { Notice } from "@commerce/ui";
import "./customer-profiles.css";

const fullName = (c: { first_name: string; last_name: string }) => [c.first_name, c.last_name].filter(Boolean).join(" ") || "Unnamed customer";
const displayValue = (v: unknown): string => v == null || v === "" ? "Not provided" : typeof v === "object" ? JSON.stringify(v) : String(v);
const label = (v: string) => v.replaceAll("_", " ").replace(/^./, c => c.toUpperCase());

function ProfileList() {
  const q = useGrid("customers", ["admin-customers"]);
  return <main className="catalog-admin"><PageHeader title={<>Customer profiles</>} description={<>Find customers and open their account, profile attributes and saved delivery addresses.</>}/>
    <Notice error>{q.error?.message}</Notice>{q.controls}
    {q.isPending ? <p role="status">Loading customers…</p> : <div className="table-wrap"><table><thead><tr><EntityIdHeading/><th>Customer</th><th>Contact</th><th>Group</th><th>Verification</th><th>Created</th><th>Actions</th></tr></thead><tbody>{q.data?.map(c => <tr key={c.id}><EntityIdCell row={c}/><td><Link to={`/customers/profiles/${c.id}`}>{fullName(c)}</Link></td><td>{c.email || c.mobile_number || "Not provided"}</td><td>{c.customer_group}</td><td><span className="badge">{c.verified ? "Verified" : "Unverified"}</span></td><td>{new Date(c.created_at).toLocaleDateString()}</td><td><RowActions label={fullName(c)} items={[{ label: "View profile", to: `/customers/profiles/${c.id}` }]} /></td></tr>)}</tbody></table>{!q.error && q.data?.length === 0 && <p>No customers match these filters.</p>}</div>}
  </main>;
}
function ProfileDetail({ id }: { id: string }) {
  const q = useQuery({ queryKey: ["admin-customer-profile", id], queryFn: () => adminCustomerApi.profile(id) });
  const [section, setSection] = useState("Overview");
  const p = q.data;
  return <main className="catalog-admin customer-profile"><Link to="/customers/profiles">← Customer profiles</Link><PageHeader title={<>{p ? fullName(p) : "Customer profile"}</>} description={<>Account information and delivery details from the customer record.</>} actions={p && <Link className="primary-link" to={`/customers/journey/${id}`}>See journey →</Link>}/>
    <Notice error>{q.error?.message}</Notice>{q.error && <button onClick={() => void q.refetch()}>Retry</button>}{q.isPending && <p role="status">Loading customer details…</p>}
    {p && <><section className="profile-summary"><div className="profile-avatar" aria-hidden="true">{(p.first_name || p.account.email || "C").slice(0, 1).toUpperCase()}</div><div><h2>{fullName(p)}</h2><p>{p.account.email || p.account.mobile_number || "No contact details"}</p><span className="badge">{p.account.verified ? "Verified account" : "Verification pending"}</span></div><dl><div><dt>Customer group</dt><dd>{p.customer_group}</dd></div><div><dt>Member since</dt><dd>{new Date(p.account.created_at).toLocaleDateString()}</dd></div><div><dt>Saved addresses</dt><dd>{p.locations.length}</dd></div></dl></section>
      <nav className="profile-sections" aria-label="Customer detail sections">{["Overview", "Delivery addresses", "Attributes"].map(s => <button className="secondary" key={s} aria-pressed={section === s} onClick={() => setSection(s)}>{s}{s === "Delivery addresses" ? ` (${p.locations.length})` : ""}</button>)}<button className="secondary" disabled={q.isFetching} onClick={() => void q.refetch()}>Refresh details</button></nav>
      {section === "Overview" && <div className="profile-panels"><section className="form-card"><h2>Account & contact</h2><dl className="detail-list">{[["Customer ID", p.account.id], ["Email", p.account.email], ["Mobile number", p.account.mobile_number], ["Sign-in identifier", p.account.primary_identifier], ["Verification", p.account.verified ? "Verified" : "Unverified"], ["Created", new Date(p.account.created_at).toLocaleString()]].map(([k,v]) => <div key={String(k)}><dt>{k}</dt><dd>{displayValue(v)}</dd></div>)}</dl></section><section className="form-card"><h2>Personal & business profile</h2><dl className="detail-list">{[["First name",p.first_name],["Last name",p.last_name],["Date of birth",p.date_of_birth],["Gender",p.gender && label(p.gender)],["Customer group",p.customer_group],["Company ID",p.company_id],["Negotiated price list ID",p.negotiated_price_list_id]].map(([k,v]) => <div key={String(k)}><dt>{k}</dt><dd>{displayValue(v)}</dd></div>)}</dl></section></div>}
      {section === "Delivery addresses" && <section><h2>Saved delivery addresses</h2>{!p.locations.length && <p>This customer has no saved delivery addresses.</p>}<div className="profile-panels">{p.locations.map(l => <article className="form-card" key={l.id}><h3>{l.custom_label || label(l.label)} {l.is_default && <span className="badge">Default</span>}</h3><p>{locationAddress(l)}</p><dl className="detail-list">{[["Building",l.building],["Floor",l.floor],["Apartment",l.apartment],["Delivery instructions",l.delivery_instructions],["Delivery area ID",l.area_id],[l.location_method === "neighborhood" ? "Approximate area coordinates" : "Entrance pin",`${l.latitude}, ${l.longitude}`],["Last updated",new Date(l.updated_at).toLocaleString()]].map(([k,v]) => <div key={String(k)}><dt>{k}</dt><dd>{displayValue(v)}</dd></div>)}</dl></article>)}</div></section>}
      {section === "Attributes" && <section className="form-card"><h2>Customer attributes</h2>{Object.keys(p.attributes).length ? <dl className="detail-list">{Object.entries(p.attributes).map(([k,v]) => <div key={k}><dt>{label(k)}</dt><dd>{displayValue(v)}</dd></div>)}</dl> : <p>No custom attributes recorded.</p>}</section>}
    </>}
  </main>;
}
export function Customers() { const { id } = useParams(); return id ? <ProfileDetail key={id} id={id}/> : <ProfileList/>; }
