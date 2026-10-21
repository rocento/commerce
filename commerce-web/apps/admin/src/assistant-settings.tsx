import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { assistantSettingsApi, type AssistantProviderSettings, type AssistantProviderInput } from "@commerce/api-client";
import { BrandLogo, Field, Notice } from "@commerce/ui";
import { PageHeader } from "./page-header";
import "./assistant-settings.css";
import { AssistantReadiness } from "./assistant-readiness";
import { useUnsavedChanges } from "./unsaved-changes";

export function AssistantSettings({ canWrite }: { canWrite: boolean }) {
  const query = useQuery({ queryKey: ["assistant-provider-settings"], queryFn: assistantSettingsApi.get });
  return <main className="assistant-settings-page">
    <PageHeader title="Shopping Assistance" description="Turn the storefront AI assistant on or off and manage its model and API key." />
    {query.isPending ? <p role="status">Loading AI configuration…</p> : query.error ? <Notice error>{query.error.message}</Notice> : query.data && <SettingsForm initial={query.data} canWrite={canWrite} />}
    <AssistantReadiness canWrite={canWrite} />
  </main>;
}
function SettingsForm({ initial, canWrite }: { initial: AssistantProviderSettings; canWrite: boolean }) {
  const queryClient = useQueryClient();
  const [saved, setSaved] = useState(initial);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [model, setModel] = useState(initial.model);
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const writable = canWrite && saved.editable;
  useUnsavedChanges(writable && (enabled !== saved.enabled || model !== saved.model || Boolean(apiKey) || clearKey));
  function changed() { setNotice(""); setError(""); }
  function input(): AssistantProviderInput {
    return { enabled, model: model.trim(), ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}), clear_key: clearKey };
  }
  async function perform(action: "save" | "test") {
    if (busy || !writable) return;
    const body = input();
    if (!body.model || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(body.model)) { setError("Enter a valid OpenAI model ID."); return; }
    if ((enabled || action === "test") && !apiKey.trim() && (!saved.key_configured || clearKey)) { setError("Enter an API key before enabling or testing OpenAI."); return; }
    setBusy(action); setError(""); setNotice("");
    try {
      if (action === "save") {
        const result = await assistantSettingsApi.save(body);
        setSaved(result); setEnabled(result.enabled); setModel(result.model); setApiKey(""); setClearKey(false);
        queryClient.setQueryData(["assistant-provider-settings"], result);
        void queryClient.invalidateQueries({ queryKey: ["assistant-readiness"] });
        setNotice("Settings saved. New assistant requests will use this configuration.");
      } else {
        const result = await assistantSettingsApi.test(body);
        if (result.ok) setNotice(`${result.message} Save to apply any changes.`);
        else setError(result.message);
      }
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to update AI settings."); }
    finally { setBusy(null); }
  }
  function submit(event: FormEvent) { event.preventDefault(); void perform("save"); }
  return <form className="assistant-settings-card" onSubmit={submit} autoComplete="off">
    <div className="assistant-settings-brand"><BrandLogo /><span>Shopping Assistance</span></div>
    <p>Manage Rocento's storefront AI assistant here. Saved changes apply to new conversations immediately, without restarting the store.</p>
    {!canWrite && <p role="status">Your role can view these settings. Editing requires AI configuration permission.</p>}
    {!saved.editable && <Notice error>Server-side settings storage is not enabled for this installation.</Notice>}
    <fieldset disabled={!writable || Boolean(busy)}>
      <label className="assistant-enable"><input type="checkbox" checked={enabled} onChange={e => { setEnabled(e.target.checked); changed(); }} />Enable AI assistant</label>
      <small>When off, new assistant requests are blocked. You can still update these settings and test the connection.</small>
      <Field label="OpenAI model" value={model} required maxLength={100} placeholder="Enter your model ID" list="openai-model-options" onChange={e => { setModel(e.target.value); changed(); }} />
      <datalist id="openai-model-options"><option value="gpt-4.1-mini" /><option value="gpt-5.6-luna" /><option value="gpt-5.6-terra" /><option value="gpt-6-astra" /></datalist>
      <small>Default: GPT-4.1 mini from OpenAI. Enter another Responses API model ID to customize it. Requires an OpenAI API key; a ChatGPT subscription does not configure this connection.</small>
      <Field label={saved.key_configured ? "Replace API key" : "OpenAI API key"} type="password" value={apiKey} maxLength={512} autoComplete="new-password" spellCheck={false} placeholder={saved.key_configured ? "Leave blank to keep the saved key" : "Enter your API key"} onChange={e => { setApiKey(e.target.value); if (e.target.value) setClearKey(false); changed(); }} />
      <small>{saved.key_configured ? "An API key is configured." : "No API key is configured."} Keys are stored on the server and are never returned to this form.</small>
      {saved.key_configured && <label className="assistant-enable"><input type="checkbox" checked={clearKey} onChange={e => { setClearKey(e.target.checked); if (e.target.checked) { setApiKey(""); setEnabled(false); } changed(); }} />Remove the configured API key</label>}
      <div className="assistant-settings-actions"><button type="submit">{busy === "save" ? "Saving…" : "Save settings"}</button><button className="secondary" type="button" onClick={() => void perform("test")}>{busy === "test" ? "Testing…" : "Test connection"}</button></div>
      <small>The connection test sends a short test message to OpenAI and may incur a small API charge.</small>
    </fieldset>
    {error && <Notice error>{error}</Notice>}
    {notice && <p role="status" className="assistant-settings-success">{notice}</p>}
  </form>;
}
