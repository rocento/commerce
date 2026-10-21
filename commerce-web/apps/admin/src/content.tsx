import { EntityIdHeading, EntityIdCell, EntityIdLabel } from "./entity-id";
import { MenuItemsEditor, MenuPreview, newMenuItem } from "./megamenu";
import { useUnsavedChanges } from "./unsaved-changes";
import { RowActions } from "./row-actions";
import { PageHeader } from "./page-header";
import { useGrid } from "./grids";
import { useLayoutEffect, useState } from "react";
import type { EditorState } from "./entity-translation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  contentApi,
  catalogApi, categoryNavigation, navigationErrors,
  mediaUrl,
  type ContentInput,
  type ContentDetail,
  type ContentBlock,
} from "@commerce/api-client";
import { Field, Notice, useAction } from "@commerce/ui";
const blankBlock: ContentBlock = {
  kind: "text",
  heading: "",
  text: "",
  image_id: null,
  link_label: "",
  link_url: "",
};
const blank: ContentInput = {
  key: "",
  kind: "page",
  expected_version: 0,
  title: "",
  blocks: [{ ...blankBlock }],
};
export function ContentAdmin({
  canWrite,
  canPublish,
}: {
  canWrite: boolean;
  canPublish: boolean;
}) {
  const q = useGrid("content", ["cms"]),
    [id, setId] = useState<string>(),
    [creating, setCreating] = useState(false);
  const detail = useQuery({
    queryKey: ["cms", id],
    queryFn: () => contentApi.detail(id!),
    enabled: !!id,
  });
  return (
    <main className="catalog-admin">
      <PageHeader title={<>Pages & blocks</>} description={<>
            Manage your homepage, static pages and footer. Drafts stay private until
            published.
          </>} actions={<>{canWrite && (
          <button
            onClick={() => {
              setId(undefined);
              setCreating(true);
            }}
          >
            New content
          </button>
        )}</>} />
      {q.controls}
      <Notice error>{q.error?.message || detail.error?.message}</Notice>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <EntityIdHeading/><th>Title / key</th>
              <th>Kind</th>
              <th>Latest version</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {q.data?.filter(d=>d.kind!=="navigation").map((d) => (
              <tr key={d.id}>
                <EntityIdCell row={d}/><td>{d.key}</td>
                <td>{d.kind}</td>
                <td>{d.version}</td>
                <td>
                  <RowActions label={d.key} items={[{ label: "Open", onSelect: () => { setCreating(false); setId(d.id); } }]} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!q.isPending && q.data?.length === 0 && (
        <p>
          No managed content yet. Create homepage content to replace the default
          hero.
        </p>
      )}
      {(creating || detail.data) && (
        <ContentEditor
          key={creating ? "new" : `${id}:${detail.data?.document.version}`}
          detail={creating ? undefined : detail.data}
          canWrite={canWrite}
          canPublish={canPublish}
          saved={(next) => {
            setCreating(false);
            setId(next);
          }}
        />
      )}
    </main>
  );
}
export function ContentEditor({
  navigation = false,
  initialNavigation,
  onStateChange,
  detail,
  canWrite,
  canPublish,
  saved,
}: {
  navigation?: boolean;
  initialNavigation?: ContentBlock[];
  onStateChange?: (state: EditorState) => void;
  detail?: ContentDetail;
  canWrite: boolean;
  canPublish: boolean;
  saved: (id: string) => void;
}) {
  const latest = detail?.revisions[0],
    cache = useQueryClient(),
    a = useAction();
  const [form, setForm] = useState<ContentInput>(
    detail && latest
      ? {
          key: detail.document.key,
          kind: detail.document.kind,
          expected_version: detail.document.version,
          title: latest.title,
          blocks: latest.blocks,
        }
      : navigation ? {...blank,kind:"navigation",key:"navigation",title:"Storefront navigation",blocks:initialNavigation ?? [newMenuItem()]} : { ...blank },
  );
  const categories = useQuery({ queryKey: ['catalog', 'categories', 'tree'], queryFn: catalogApi.adminCategories, enabled: navigation });
  const menuErrors = navigation ? navigationErrors(form.blocks) : [];
  const [baseline, setBaseline] = useState(JSON.stringify(form));
  const dirty = JSON.stringify(form) !== baseline;
  useUnsavedChanges(dirty);
  useLayoutEffect(() => { onStateChange?.({dirty,busy:a.busy}); }, [dirty,a.busy,onStateChange]);
  const [revision, setRevision] = useState(latest?.id ?? "");
  const [selectedRevision,setSelectedRevision] = useState(latest);
  const revisions=useGrid("cms-revisions",["cms","revisions",detail?.document.id],{document_id:detail?.document.id},!!detail);
  const releases=useGrid("cms-releases",["cms","releases",detail?.document.id],{document_id:detail?.document.id},!!detail);
  const revisionRows=[...(selectedRevision && !(revisions.data ?? []).some(r=>r.id===selectedRevision.id) ? [selectedRevision] : []),...(revisions.data ?? [])];

  const media = useQuery({
    queryKey: ["cms-media"],
    queryFn: contentApi.media,
  });
  function block(n: number, next: ContentBlock) {
    setForm({
      ...form,
      blocks: form.blocks.map((b, i) => (i === n ? next : b)),
    });
  }
  async function release(
    revision_id: string | null,
    starts_at: string | null,
    ends_at: string | null,
  ) {
    await contentApi.publish(detail!.document.id, {
      revision_id,
      starts_at,
      ends_at,
    });
    await cache.invalidateQueries({ queryKey: ["cms"] });
    a.setMessage(
      starts_at
        ? "Release scheduled. The current content stays live until then."
        : revision_id
          ? "Content published. Refresh the storefront to see it."
          : "Content unpublished.",
    );
  }
  return (
    <section className={`form-card ${navigation ? "menu-content-editor" : ""}`}>
      <h2>{navigation ? "Navigation draft" : detail ? `Edit ${detail.document.key}` : "New content"}</h2>
      <Notice error>{a.error || media.error?.message}</Notice>
      <Notice>{a.message}</Notice>
      {detail && (
        <>
          {navigation ? <details className="menu-revision-browser"><summary>Browse saved revisions</summary>{revisions.controls}</details> : revisions.controls}<label className="field">
            Revision
            <select
              value={revision}
              onChange={(e) => {setRevision(e.target.value);setSelectedRevision(revisionRows.find(r=>r.id===e.target.value));}}
            >
              {revisionRows.map((r) => (
                <option value={r.id} key={r.id}>
                  Version {r.version} — {r.title}
                </option>
              ))}
            </select>
          </label>
          {canWrite && (
            <button
              className="secondary"
              onClick={() => {
                const r = revisionRows.find((r) => r.id === revision);
                if(r) setForm({ ...form, title: r.title, blocks: r.blocks });
              }}
            >
              Use selected revision as draft
            </button>
          )}
        </>
      )}
      {canWrite && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void a.run(async () => {
              if (navigation && menuErrors.length) throw new Error(menuErrors.join(" "));
              const r = await contentApi.save(form);
              setBaseline(JSON.stringify(form));
              await cache.invalidateQueries({ queryKey: ["cms"] });
              saved(r.document_id);
              a.setMessage("Draft saved. Publish a revision when ready.");
            });
          }}
        >
          <div className="form-grid">
            {!navigation && <label className="field">
              Content kind
              <select
                disabled={!!detail}
                value={form.kind}
                onChange={(e) => {
                  const kind = e.target.value as ContentInput["kind"];
                  setForm({ ...form, kind, key: kind === "page" ? "" : kind });
                }}
              >
                <option value="page">Static page</option>
                <option value="home">Homepage</option>
                <option value="footer">Footer</option>
              </select>
            </label>}
            {!navigation && <Field
              label="Page key (URL slug)"
              required
              pattern="[a-z0-9-]+"
              maxLength={100}
              disabled={!!detail || form.kind !== "page"}
              value={form.key}
              onChange={(e) => setForm({ ...form, key: e.target.value })}
            />}
            <Field
              label={navigation ? "Menu title" : "Page title"}
              required
              maxLength={200}
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
            />
          </div>
          {navigation && <section className="menu-connection" aria-label="Storefront menu connection">
            <h3>Storefront category bar</h3>
            <p>This menu controls the horizontal category bar and its dropdowns. Labels, destinations, visibility and order are released together. Category links use the catalog URL keys.</p>
            <button type="button" className="secondary" disabled={categories.isPending || !!categories.error || !categories.data?.length || categoryNavigation(categories.data ?? []).length > 30} onClick={() => {
              const initial = !detail && form.blocks.length === 1 && form.blocks[0].link_label === 'New menu';
              if (!initial && !window.confirm('Replace this draft with Shop all and the top-level catalog categories? This affects the draft only.')) return;
              setForm({ ...form, blocks: categoryNavigation(categories.data ?? []) });
            }}>Use catalog category bar</button>
            {categories.error && <p role="alert">Categories could not be loaded. <button type="button" onClick={() => void categories.refetch()}>Retry categories</button></p>}
            {categories.data && categoryNavigation(categories.data).length > 30 && <p>The catalog has more than 29 top-level categories. Add the categories you want individually.</p>}
          </section>}
          {navigation ? <MenuItemsEditor blocks={form.blocks} onChange={blocks=>setForm({...form,blocks})}/> : <>{form.blocks.map((b, n) => (
            <fieldset key={n}>
              <legend>Block {n + 1}</legend>
              <label className="field">
                Block type
                <select
                  value={b.kind}
                  onChange={(e) =>
                    block(n, {
                      ...b,
                      kind: e.target.value as ContentBlock["kind"],
                    })
                  }
                >
                  <option value="hero">Hero banner</option>
                  <option value="text">Text section</option>
                  <option value="link">Link</option>
                </select>
              </label>
              <Field
                label="Heading"
                maxLength={200}
                value={b.heading}
                onChange={(e) => block(n, { ...b, heading: e.target.value })}
              />
              <label className="field">
                Text
                <textarea
                  maxLength={10000}
                  value={b.text}
                  onChange={(e) => block(n, { ...b, text: e.target.value })}
                />
              </label>
              <label className="field">
                Image
                <select
                  value={b.image_id ?? ""}
                  onChange={(e) =>
                    block(n, { ...b, image_id: e.target.value || null })
                  }
                >
                  <option value="">No image</option>
                  {media.data?.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.alt}
                    </option>
                  ))}
                </select>
              </label>
              {b.image_id && (
                <img
                  className="cms-preview-image"
                  src={mediaUrl(b.image_id)}
                  alt={b.heading}
                />
              )}
              <div className="form-grid">
                <Field
                  label="Link label"
                  maxLength={100}
                  value={b.link_label}
                  onChange={(e) =>
                    block(n, { ...b, link_label: e.target.value })
                  }
                />
                <Field
                  label="Link destination (local path or https URL)"
                  maxLength={2000}
                  value={b.link_url}
                  onChange={(e) => block(n, { ...b, link_url: e.target.value })}
                />
              </div>
              <button
                type="button"
                className="secondary"
                disabled={n === 0}
                onClick={() => {
                  const blocks = [...form.blocks];
                  [blocks[n - 1], blocks[n]] = [blocks[n], blocks[n - 1]];
                  setForm({ ...form, blocks });
                }}
              >
                Move up
              </button>{" "}
              <button
                type="button"
                className="text-button danger"
                onClick={() =>
                  setForm({
                    ...form,
                    blocks: form.blocks.filter((_, i) => i !== n),
                  })
                }
              >
                Remove block
              </button>
            </fieldset>
          ))}
          <button
            type="button"
            className="secondary"
            disabled={form.blocks.length >= 30}
            onClick={() =>
              setForm({ ...form, blocks: [...form.blocks, { ...blankBlock }] })
            }
          >
            Add block
          </button></>}{" "}
          {navigation && menuErrors.length > 0 && <div role="alert" className="menu-validation"><strong>Resolve before saving</strong><ul>{menuErrors.map(error => <li key={error}>{error}</li>)}</ul></div>}
          {navigation ? <div className="menu-save-bar"><div><strong>{JSON.stringify(form)!==baseline ? 'Unsaved changes' : 'Draft up to date'}</strong><span>{menuErrors.length ? `${menuErrors.length} issues to resolve before saving` : 'Save your draft, then publish when ready.'}</span></div><button disabled={a.busy || menuErrors.length > 0}>{a.busy ? 'Saving…' : 'Save draft'}</button></div> : <button disabled={a.busy}>Save draft</button>}
        </form>
      )}
      <details open={navigation || undefined}>
        <summary>Preview draft content</summary>
        <h2>{form.title}</h2>
        {navigation ? <MenuPreview blocks={form.blocks}/> : form.blocks.map((b, n) => (
          <section key={n}>
            <h3>{b.heading}</h3>
            <p style={{ whiteSpace: "pre-wrap" }}>{b.text}</p>
            {b.image_id && (
              <img
                className="cms-preview-image"
                src={mediaUrl(b.image_id)}
                alt={b.heading}
              />
            )}
            <p>
              {b.link_label} {b.link_url}
            </p>
          </section>
        ))}
      </details>
      {detail && canPublish && (
        <form
          className="form-card"
          onSubmit={(e) => {
            e.preventDefault();
            const d = new FormData(e.currentTarget);
            const date = (key: string) =>
              d.get(key) ? new Date(String(d.get(key))).toISOString() : null;
            void a.run(() =>
              release(
                String(d.get("action")) === "unpublish" ? null : revision,
                date("starts_at"),
                date("ends_at"),
              ),
            );
          }}
        >
          <h3>Publish or schedule selected revision</h3>
          {navigation && <p>Each release includes reviewed translations that match the selected menu revision. Publish again after reviewing translation changes to update Arabic and English on the storefront.</p>}
          <label className="field">
            Action
            <select name="action">
              <option value="publish">Publish selected revision</option>
              <option value="unpublish">Unpublish content</option>
            </select>
          </label>
          <Field
            label="Start (local time; blank = now)"
            name="starts_at"
            type="datetime-local"
          />
          <Field
            label="Unpublish at (local time; optional)"
            name="ends_at"
            type="datetime-local"
          />
          <p>
            This replaces any future release for this page. Unpublishing never
            brings back an older revision. Homepage, footer and navigation return to their
            default layout.
          </p>
          {JSON.stringify(form) !== baseline && <p>Save your draft before applying a release.</p>}
          <button disabled={a.busy || !revision || JSON.stringify(form) !== baseline}>Apply release</button>
        </form>
      )}
      {detail && (
        <>
          <h3>Release history</h3>{releases.controls}
          {releases.data?.map((r) => (
            <p key={r.id}><EntityIdLabel row={r}/>
              {r.cancelled
                ? "Cancelled"
                : r.revision_id
                  ? `Revision ${r.revision_id}`
                  : "Unpublish"}{" "}
              · {new Date(r.starts_at).toLocaleString()}
              {r.ends_at ? ` → ${new Date(r.ends_at).toLocaleString()}` : ""}
            </p>
          ))}
        </>
      )}
    </section>
  );
}
