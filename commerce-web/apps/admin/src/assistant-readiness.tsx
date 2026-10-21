import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { assistantSettingsApi } from "@commerce/api-client";
import { Field, Notice } from "@commerce/ui";

export function AssistantReadiness({ canWrite }: { canWrite: boolean }) {
  const readiness = useQuery({ queryKey: ["assistant-readiness"], queryFn: assistantSettingsApi.readiness, retry: false });
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function accept(event: FormEvent) {
    event.preventDefault();
    if (busy || !canWrite || !query.trim()) return;
    setBusy(true); setError("");
    try { await assistantSettingsApi.acceptance({ query: query.trim() }); await readiness.refetch(); }
    catch (e) { setError(e instanceof Error ? e.message : "Store acceptance is unavailable."); }
    finally { setBusy(false); }
  }
  const data = readiness.data;
  const labels: Record<string, string> = { provider: "Provider configuration", assistant: "Assistant enabled", catalog_tools: "Live catalog tools", tool_schemas: "Tool schema compatibility", knowledge: "Approved knowledge", storage: "Assistant storage", commerce_schema: "Commerce schema" };
  return <section className="assistant-settings-card assistant-readiness" aria-label="Store readiness">
    <h2>Store readiness</h2>
    <p>Check this store's configuration and current catalog connection before accepting a build.</p>
    {readiness.isPending && <p role="status">Checking readiness…</p>}
    {readiness.error && <Notice error>{readiness.error.message}</Notice>}
    <button type="button" className="secondary" disabled={readiness.isFetching || busy} onClick={() => void readiness.refetch()}>Refresh readiness</button>
    {data && <>
      <dl className="assistant-readiness-checks">{data.checks.map(check => <div key={check.name}><dt>{labels[check.name]}</dt><dd><strong>{check.status.replaceAll("_", " ")}</strong> — {check.message}</dd></div>)}</dl>
      <p>Checkout currency: {data.currency_modes.join(", ")}. Quantities: {data.quantity_modes.join(", ").replaceAll("_", " ")}. Payments: {data.payment_modes.join(", ").replaceAll("_", " ")}.</p>
      <p>Delivery: {data.delivery_modes.join(", ").replaceAll("_", " ")}. Enabled flags: {data.feature_flags.join(", ") || "none"}.</p>
      <h3>Store acceptance: {data.last_acceptance.status.replaceAll("_", " ")}</h3>
      <p role="status">{data.last_acceptance.message}</p>
      {data.last_acceptance.checked_at && <p>Last checked: {new Date(data.last_acceptance.checked_at).toLocaleString()}. Duration: {data.last_acceptance.duration_ms} ms.</p>}
      <form onSubmit={event => void accept(event)}>
        <fieldset disabled={!canWrite || busy || !data.provider_configured || !data.enabled}>
          <Field label="Known catalog product" value={query} required maxLength={200} placeholder="Enter a product name from this store" onChange={event => setQuery(event.target.value)} />
          <button type="submit">{busy ? "Running store acceptance…" : "Run store acceptance"}</button>
          <small>This reads the public catalog and sends one sample product to the configured model. It may incur an API charge. It validates tool schemas and a rich product card; complete shopping journeys are checked separately.</small>
        </fieldset>
      </form>
      <details><summary>Build and configuration references</summary><p>Store: {data.tenant_id}</p><p>Configuration: {data.configuration_revision}</p><p>Tools: {data.tool_schema_revision}</p></details>
    </>}
    {error && <Notice error>{error}</Notice>}
  </section>;
}
