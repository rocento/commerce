import { MobileAssets } from "./mobile-assets";
import { appendGroceryBanners, groceryBannerArtwork } from "./mobile-banner-demos";
import { MobileReadiness } from "./mobile-readiness";
import { MobileBannerSettings } from "./mobile-banner-settings";
import { MobileFeedPicker } from "./mobile-feed-picker";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useBlocker } from "react-router-dom";
import {
  mobileApi,
  mobileConfigIssues,
  MobileApiError,
  type AdminIdentity,
  type MobileAction,
  type MobileAsset,
  type MobileAuditEvent,
  type MobileConfig,
  type MobileDraft,
  type MobileEnvironment,
  type MobileIssue,
  type MobileMerchant,
  type MobileSection,
  type MobileVersion,
} from "@commerce/api-client";
import {
  asDraft,
  canEditMobile,
  canonical,
  configDiff,
  EMPTY_ASSET,
  initialConfig,
  defaultMobileMerchant,
} from "./mobile-studio-model";
import { MobileBrandTheme } from "./mobile-brand-theme";
import { RocentoBrand } from "./rocento-brand";
import { MobileDevices } from "./mobile-devices";
import { MobileCategoryPicker } from "./mobile-category-picker";
import { MobileSections } from "./mobile-sections";
import { withSectionRuntime } from "./mobile-section-library";
import { NativePreviewSession } from "./native-preview-session";
const message = (e: unknown) =>
  e instanceof Error
    ? e.message
    : "The request could not be completed. Please retry.";
type Panel =
  | "Release readiness"
  | "Brand & theme"
  | "Sections"
  | "Navigation"
  | "Features"
  | "Languages"
  | "Assets"
  | "Native Preview"
  | "Release history"
  | "Test installations";
const panels: Panel[] = [
  "Release readiness",
  "Brand & theme",
  "Sections",
  "Navigation",
  "Features",
  "Languages",
  "Assets",
  "Native Preview",
  "Release history",
  "Test installations",
];
const panelIcons: Record<Panel, ReactNode> = {
  "Release readiness": <><path d="m5 12 4 4L19 6" /><rect x="3" y="3" width="18" height="18" rx="3" /></>,
  "Brand & theme": <><path d="m14 4 6 6M4 20l4-1 13-13a2.1 2.1 0 0 0-3-3L5 16l-1 4Z" /><path d="m5 16 3 3" /></>,
  "Sections": <><rect x="3" y="3" width="18" height="5" rx="1.5" /><rect x="3" y="12" width="7" height="9" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /></>,
  "Navigation": <><circle cx="12" cy="12" r="9" /><path d="m16 8-2.5 5.5L8 16l2.5-5.5L16 8Z" /></>,
  "Features": <><path d="M3 6h10m4 0h4M3 12h4m4 0h10M3 18h10m4 0h4" /><circle cx="15" cy="6" r="2" /><circle cx="9" cy="12" r="2" /><circle cx="15" cy="18" r="2" /></>,
  "Languages": <><path d="M3 5h12M9 3v2M5 5c0 5 4 9 8 10M13 5c0 5-4 9-9 11M14 21l4-10 4 10M16 17h4" /></>,
  "Assets": <><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="8" cy="8" r="1.5" /><path d="m21 15-5-5L5 21M3 16l4-4 4 4" /></>,
  "Native Preview": <><rect x="6" y="2" width="12" height="20" rx="3" /><path d="m10 9 5 3-5 3V9ZM10 5h4M11 19h2" /></>,
  "Release history": <><path d="M3 10a9 9 0 1 1 2 8M3 4v6h6M12 7v5l3 2" /></>,
  "Test installations": <><rect x="6" y="2" width="12" height="20" rx="3" /><path d="M10 5h4m-5 7 2 2 4-4M11 19h2" /></>,
};
function PanelIcon({ panel }: { panel: Panel }) {
  return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{panelIcons[panel]}</svg>;
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="ms-field">
      <span>{label}</span>
      {children}
    </label>
  );
}
function Issues({ issues }: { issues: MobileIssue[] }) {
  return issues.length ? (
    <div className="ms-error" role="alert">
      <strong>Resolve these checks</strong>
      <ul>
        {issues.slice(0, 12).map((v, i) => (
          <li key={i}>
            <code>{v.path || "/"}</code> — {v.code.replaceAll("_", " ")}
          </li>
        ))}
      </ul>
    </div>
  ) : null;
}
export function MobileStudio({
  identity,
  logout,
}: {
  identity: AdminIdentity;
  logout: () => Promise<void>;
}) {
  const [merchants, setMerchants] = useState<MobileMerchant[]>(),
    [error, setError] = useState(""),
    [selected, setSelected] = useState("");
  const env: MobileEnvironment = "production";
  const guard = useRef<() => boolean>(() => true);
  const [scopeBusy, setScopeBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    mobileApi
      .merchants(controller.signal)
      .then(setMerchants)
      .catch((e) => {
        if (!controller.signal.aborted) setError(message(e));
      });
    return () => controller.abort();
  }, []);
  const merchant = defaultMobileMerchant(merchants ?? [], selected);
  return (
    <div className={`ms-app${merchant ? " ms-app-with-sidebar" : ""}`}>
      <header className="ms-topbar">
        {!merchant && <RocentoBrand studio />}
        <div className="ms-title-row">
          <div>
            <h1>Your mobile experience</h1>
            <p>
              One design, two platforms. Make every visit feel like your brand.
            </p>
          </div>
        </div>
        <div className="ms-header-controls">
          <div className="ms-scope">
            <Field label="Merchant">
              <select
                value={merchant?.id || ""}
                onChange={(e) => {
                  if (guard.current()) setSelected(e.target.value);
                }}
                disabled={scopeBusy || !merchants?.length}
              >
                {!merchants?.length && <option>No mobile memberships</option>}
                {merchants?.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </Field>
            <div className="ms-production-badge">Production</div>
          </div>
        <div className="ms-account">
          <span>{identity.user.name}</span>
          <button
            disabled={scopeBusy}
            onClick={() => {
              if (guard.current())
                void logout().catch((e) => setError(message(e)));
            }}
          >
            Sign out
          </button>
        </div>
        </div>
      </header>
      <main className="ms-main">
        {error && (
          <p className="ms-error" role="alert">
            {error}
          </p>
        )}
        {!merchants && !error && (
          <p role="status">Loading your mobile memberships…</p>
        )}
        {merchants?.length === 0 && (
          <section className="ms-card">
            <h2>Mobile membership required</h2>
            <p>
              Your account has no active mobile merchant membership. Ask your
              mobile workspace owner to provision access.
            </p>
          </section>
        )}
        {merchant && (
          <Editor
            key={`${merchant.id}:${env}`}
            merchant={merchant}
            env={env}
            guard={guard}
            setScopeBusy={setScopeBusy}
          />
        )}
      </main>
      <footer className="ms-footer">
        Rocento Mobile App Studio <span>iOS + Android · Contract 1.0.0</span>
      </footer>
    </div>
  );
}
function Editor({
  merchant,
  env,
  guard,
  setScopeBusy,
}: {
  merchant: MobileMerchant;
  env: MobileEnvironment;
  guard: React.MutableRefObject<() => boolean>;
  setScopeBusy: (busy: boolean) => void;
}) {
  const [base, setBase] = useState<MobileDraft | null>(),
    [config, setConfig] = useState<MobileConfig>(),
    [assets, setAssets] = useState<MobileAsset[]>([]),
    [versions, setVersions] = useState<MobileVersion[]>([]),
    [audit, setAudit] = useState<MobileAuditEvent[]>([]);
  const [error, setError] = useState(""),
    [serverIssues, setServerIssues] = useState<MobileIssue[]>([]),
    [conflict, setConflict] = useState(false),
    [paused, setPaused] = useState(false),
    [saving, setSaving] = useState(false),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [validated, setValidated] = useState<number>();
  const [panel, setPanel] = useState<Panel>("Brand & theme"),
    [selected, setSelected] = useState(""),
    [retryLoad, setRetryLoad] = useState(0);
  const [review, setReview] = useState<{
      kind: "publish" | "rollback";
      version?: MobileVersion;
    }>(),
    [approved, setApproved] = useState(false);
  const [previewActive, setPreviewActive] = useState(false);
  const [previewContainer, setPreviewContainer] = useState<HTMLElement | null>(null);
  const [moreVersions, setMoreVersions] = useState(false),
    [moreAudit, setMoreAudit] = useState(false);
  const saveLock = useRef(false),
    commandLock = useRef(false),
    alive = useRef(true),
    keys = useRef(new Map<string, string>()),
    dialog = useRef<HTMLDialogElement>(null);
  const editable = canEditMobile(merchant.role),
    owner = merchant.role === "owner",
    designable = editable;
  const dirty = !!config && canonical(config) !== canonical(base?.config);
  const issues = useMemo(
    () =>
      config
        ? mobileConfigIssues(config, merchant.id, merchant.entitlements)
        : [],
    [config, merchant.id, merchant.entitlements],
  );
  const locked = busy || !!review || conflict;
  const scopeBusy = saving || busy || !!review;
  useEffect(() => {
    setScopeBusy(scopeBusy);
    return () => setScopeBusy(false);
  }, [scopeBusy, setScopeBusy]);
  const current = useRef(config);
  current.current = config;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    Promise.all([
      mobileApi.draft(merchant.id, env, controller.signal).catch((e) => {
        if (e instanceof MobileApiError && e.status === 404) return null;
        throw e;
      }),
      mobileApi.assets(merchant.id, env, controller.signal),
      mobileApi.versions(merchant.id, env, controller.signal),
      mobileApi.audit(merchant.id, env, controller.signal),
    ])
      .then(([d, a, v, log]) => {
        if (controller.signal.aborted) return;
        setBase(d);
        setConfig(
          d?.config ||
            (v[0]
              ? asDraft(v[0].config)
              : initialConfig(
                  merchant,
                  a.find((a) => a.verified && a.kind === "image")?.id,
                )),
        );
        setAssets(a);
        setVersions(v);
        setAudit(log);
        setMoreVersions(v.length === 50);
        setMoreAudit(log.length === 50);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(message(e));
      });
    return () => controller.abort();
  }, [merchant, env, retryLoad]);
  useEffect(() => {
    guard.current = () => {
      if (saveLock.current || commandLock.current) {
        setNotice(
          "Wait for the current request to finish before switching workspace.",
        );
        return false;
      }
      return (
        !dirty ||
        window.confirm(
          "This draft has unsaved changes. Leave and discard them?",
        )
      );
    };
    return () => {
      guard.current = () => true;
    };
  }, [dirty, guard]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty || saving || busy) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, saving, busy]);
  const blocker = useBlocker(dirty || saving || busy);
  useEffect(() => {
    if (blocker.state === "blocked") {
      if (guard.current()) blocker.proceed();
      else blocker.reset();
    }
  }, [blocker, guard]);
  useEffect(() => {
    if (review) {
      dialog.current?.showModal();
    }
  }, [review]);
  function openReview(value: {
    kind: "publish" | "rollback";
    version?: MobileVersion;
  }) {
    setApproved(false);
    setError("");
    setServerIssues([]);
    setReview(value);
  }
  const revision = base?.revision;
  useEffect(() => {
    if (panel !== "Release history" || !revision) return;
    const controller = new AbortController();
    mobileApi
      .audit(merchant.id, env, controller.signal)
      .then((rows) => {
        if (!controller.signal.aborted) {
          setAudit(rows);
          setMoreAudit(rows.length === 50);
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(message(e));
      });
    return () => controller.abort();
  }, [panel, revision, merchant.id, env]);
  function failure(e: unknown) {
    setError(message(e));
    setServerIssues(e instanceof MobileApiError ? e.issues : []);
    if (e instanceof MobileApiError && e.status === 409) setConflict(true);
  }
  const save = useCallback(async () => {
    if (
      !current.current ||
      saveLock.current ||
      commandLock.current ||
      !designable ||
      conflict ||
      issues.length
    )
      return;
    const sent = structuredClone(current.current);
    saveLock.current = true;
    setSaving(true);
    setError("");
    try {
      const saved = await mobileApi.save(
        merchant.id,
        env,
        base?.revision || 0,
        sent,
      );
      if (!alive.current) return;
      setBase(saved);
      if (canonical(current.current) === canonical(sent))
        setConfig(saved.config);
      setPaused(false);
      setServerIssues([]);
      setNotice(`Draft revision ${saved.revision} saved.`);
    } catch (e) {
      if (alive.current) {
        setPaused(true);
        setError(message(e));
        setServerIssues(e instanceof MobileApiError ? e.issues : []);
        if (e instanceof MobileApiError && e.status === 409) setConflict(true);
      }
    } finally {
      saveLock.current = false;
      if (alive.current) setSaving(false);
    }
  }, [designable, conflict, issues.length, merchant.id, env, base?.revision]);
  useEffect(() => {
    if (
      !dirty ||
      !designable ||
      paused ||
      conflict ||
      saving ||
      busy ||
      review ||
      issues.length
    )
      return;
    const timer = setTimeout(() => void save(), 900);
    return () => clearTimeout(timer);
  }, [
    dirty,
    designable,
    paused,
    conflict,
    saving,
    busy,
    review,
    issues.length,
    save,
    config,
  ]);
  function change(next: MobileConfig) {
    if (!designable || locked) return;
    next = withSectionRuntime(next);
    current.current = next;
    setConfig(next);
    setValidated(undefined);
    setPaused(false);
    setError("");
    setServerIssues([]);
    setNotice("");
  }
  function update(mutator: (copy: MobileConfig) => void) {
    if (!config) return;
    const copy = structuredClone(config);
    mutator(copy);
    change(copy);
  }
  async function refresh() {
    const [d, v, log] = await Promise.all([
      mobileApi.draft(merchant.id, env),
      mobileApi.versions(merchant.id, env),
      mobileApi.audit(merchant.id, env),
    ]);
    if (!alive.current) return;
    setBase(d);
    setConfig(d.config);
    setVersions(v);
    setAudit(log);
    setMoreVersions(v.length === 50);
    setMoreAudit(log.length === 50);
    setConflict(false);
    setPaused(false);
    setValidated(undefined);
    setServerIssues([]);
  }
  async function command(fn: () => Promise<void>) {
    if (commandLock.current || saveLock.current) return;
    commandLock.current = true;
    setBusy(true);
    setError("");
    setServerIssues([]);
    try {
      await fn();
    } catch (e) {
      if (alive.current) failure(e);
    } finally {
      commandLock.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function validate() {
    setValidated(undefined);
    await command(async () => {
      await mobileApi.validate(merchant.id, env);
      setValidated(base?.revision);
      setNotice(
        "Server validation passed. Review the changes to approve this release.",
      );
    });
  }
  async function publish() {
    if (!review || !base || !approved) return;
    await command(async () => {
      const signature = `${review.kind}:${base.revision}:${review.version?.version || 0}`;
      const key = keys.current.get(signature) || crypto.randomUUID();
      keys.current.set(signature, key);
      const result =
        review.kind === "publish"
          ? await mobileApi.publish(merchant.id, env, base.revision, key)
          : await mobileApi.rollback(
              merchant.id,
              env,
              base.revision,
              review.version!.version,
              key,
            );
      setReview(undefined);
      setValidated(undefined);
      setNotice(
        `Version ${result.version} published to ${env}${review.kind === "rollback" ? ` by restoring version ${review.version!.version}` : ""}. No store build required.`,
      );
      // Publication is committed. A refresh failure must never imply it was rolled back.
      try {
        await refresh();
      } catch {
        setConflict(true);
        setError(
          `Version ${result.version} is published. Reload the draft before continuing; the refresh failed.`,
        );
      }
    });
  }
  async function loadMore(kind: "versions" | "audit") {
    await command(async () => {
      if (kind === "versions") {
        const rows = await mobileApi.versions(
          merchant.id,
          env,
          undefined,
          versions.at(-1)?.version,
        );
        setVersions((v) => [...v, ...rows]);
        setMoreVersions(rows.length === 50);
      } else if (kind === "audit") {
        const rows = await mobileApi.audit(
          merchant.id,
          env,
          undefined,
          audit.at(-1)?.id,
        );
        setAudit((v) => [...v, ...rows]);
        setMoreAudit(rows.length === 50);

      }
    });
  }
  if (!config || base === undefined)
    return (
      <section className="ms-card">
        {error ? (
          <>
            <p role="alert" className="ms-error">
              {error}
            </p>
            <button onClick={() => setRetryLoad((v) => v + 1)}>
              Retry loading workspace
            </button>
          </>
        ) : (
          <p role="status">
            Loading {merchant.name} · {env}…
          </p>
        )}
      </section>
    );
  const section =
    config.screens.home.sections.find((s) => s.id === selected) ||
    config.screens.home.sections[0];
  const patchSection = (props: Partial<MobileSection["props"]>) =>
    update((c) => {
      const s = c.screens.home.sections.find((s) => s.id === section.id)!;
      Object.assign(s.props, props);
    });
  const diff = configDiff(
    versions[0]?.config,
    review?.kind === "rollback" ? review.version?.config : config,
  );
  return (
    <>
      {!editable && (
        <p className="ms-info">
          Your {merchant.role.replace("_", " ")} role can preview this
          workspace. An owner or designer can edit; only an owner can publish.
        </p>
      )}
      {editable && !owner && (
        <p className="ms-info">
          You can design and validate. A mobile merchant owner must approve and
          publish releases.
        </p>
      )}

      {notice && (
        <p className="ms-notice" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="ms-error" role="alert">
          {error}
        </p>
      )}
      {conflict && (
        <div className="ms-error">
          <strong>
            The saved revision changed. Your local edits are preserved.
          </strong>
          <button
            disabled={busy || saving}
            onClick={() => {
              if (
                window.confirm(
                  "Discard your local changes and load the latest saved draft?",
                )
              )
                void command(refresh);
            }}
          >
            Load latest draft
          </button>
          <button
            onClick={() => {
              const url = URL.createObjectURL(
                new Blob([JSON.stringify(config, null, 2)], {
                  type: "application/json",
                }),
              );
              const a = document.createElement("a");
              a.href = url;
              a.download = `mobile-draft-${merchant.id}-${env}.json`;
              a.click();
              URL.revokeObjectURL(url);
            }}
          >
            Download local draft
          </button>
        </div>
      )}
      <Issues issues={[...issues, ...serverIssues]} />
      <div className={`ms-workbench${panel !== "Native Preview" ? " is-settings-panel" : ""}${panel === "Brand & theme" ? " is-brand-panel" : ""}${panel === "Sections" ? " is-sections-panel" : ""}`}>
        <nav className="ms-sidebar" aria-label="Studio tools">
          <RocentoBrand studio />
          {panels.map((p) => (
            <button
              key={p}
              className={panel === p ? "is-active" : ""}
              aria-current={panel === p ? "page" : undefined}
              onClick={() => setPanel(p)}
            >
              <PanelIcon panel={p} />
              <span>{p}</span>
              {p === "Native Preview" && previewActive && <span className="ms-preview-active-dot" role="img" aria-label="Preview session active" />}
            </button>
          ))}
        </nav>
        <aside className="ms-tools">
          <div className="ms-panel">
            <section className="ms-release-bar" aria-label="Draft and publishing">
              <div>
                <span
                  className={`ms-status ${env === "production" ? "ms-production" : ""}`}
                >
                  {env}
                </span>
                <span className="ms-role">{merchant.role.replace("_", " ")}</span>
                <span role="status">
                  {saving
                    ? "Saving…"
                    : dirty
                      ? "Unsaved changes"
                      : `Draft r${base?.revision || 0} · Saved`}
                </span>
                {versions[0] && <span>Live v{versions[0].version}</span>}
              </div>
              <div className="ms-actions">
                <button
                  disabled={
                    !designable || !dirty || saving || locked || !!issues.length
                  }
                  onClick={() => void save()}
                >
                  Save draft
                </button>
                <button
                  disabled={
                    !editable || dirty || !base || saving || locked || !!issues.length
                  }
                  onClick={() => void validate()}
                >
                  {validated === base?.revision && base
                    ? "✓ Validated"
                    : "Validate draft"}
                </button>
                <button
                  className="ms-primary"
                  disabled={
                    !owner ||
                    !base ||
                    dirty ||
                    saving ||
                    locked ||
                    !!issues.length ||
                    validated !== base.revision
                  }
                  onClick={() => openReview({ kind: "publish" })}
                >
                  Review & publish
                </button>
              </div>
            </section>
            <section className="ms-preview-settings" hidden={panel !== "Native Preview"} aria-label="Native Preview controls">
              <div className="ms-panel-heading"><h2>Native Preview</h2><span>Test your saved draft</span></div>
              <NativePreviewSession
                key={`${merchant.id}:${env}`}
                merchant={merchant.id}
                environment={env}
                owner={owner}
                onActiveChange={setPreviewActive}
                savedRevision={base?.revision}
                hasLocalChanges={dirty}
                previewContainer={previewContainer}
              />
            </section>
            <section className="ms-editor-section" hidden={panel === "Native Preview"}>
            <div className="ms-panel-heading">
              <h2>{panel}</h2>
              <span>
                {panel === "Release history"
                  ? "Immutable releases"
                  : panel === "Assets" ? "Private image library" : panel === "Test installations" ? "Owner-approved access" : panel === "Release readiness" ? "Checks before publication" : "Can publish remotely"}
              </span>
            </div>
            {panel === "Release readiness" && <MobileReadiness config={config} issues={[...issues, ...serverIssues]}
              saved={!!base && !dirty && !saving} validated={!!base && !dirty && validated === base.revision}
              owner={owner} openPanel={setPanel} />}
            {panel === "Test installations" && <MobileDevices key={merchant.id} merchant={merchant} />}
            {panel === "Brand & theme" && (
              <MobileBrandTheme brand={config.brand} assets={assets} merchant={merchant.id}
                disabled={!designable || locked}
                change={patch => update(c => { Object.assign(c.brand, patch); })}
                openAssets={() => setPanel("Assets")} openPreview={() => setPanel("Native Preview")} />
            )}
            {panel === "Sections" && (
              <MobileSections addGroceryDemos={() => void command(async () => {
                const images: Record<string, string> = {};
                for (const artwork of groceryBannerArtwork) {
                  let asset = assets.find(a => a.name === artwork.name && a.verified);
                  if (!asset) {
                    const response = await fetch(artwork.url);
                    if (!response.ok) throw new Error('Demo artwork is unavailable.');
                    const blob = await response.blob();
                    asset = await mobileApi.upload(merchant.id, env, artwork.name, new File([blob], `${artwork.key}.png`, { type: 'image/png' }));
                    setAssets(previous => [asset!, ...previous]);
                  }
                  images[artwork.key] = asset.id;
                }
                const next = appendGroceryBanners(current.current || config, images);
                change(next);
                setSelected(next.screens.home.sections.at(-2)!.id);
                setNotice('Added both grocery banner demos. Review the draft before publishing.');
              })} config={config} section={section} disabled={!designable || locked}
                issues={[...issues, ...serverIssues]} change={change} select={setSelected}
                settings={<SectionFields section={section} config={config} assets={assets} patch={patchSection} />} />
            )}
            {panel === "Navigation" && (
              <fieldset disabled={!designable || locked}>
                <p className="ms-help">
                  Home, cart and account are required. Up and down buttons set
                  tab order.
                </p>
                <p className="ms-help">
                  Icons use each platform’s native style and appear in both previews.
                  Publishing icon choices requires app runtime 1.1 or later; Deals requires 1.2.
                </p>
                {config.navigation.tabs.map((tab, i) => (
                  <div className="ms-tab-row" key={tab}>
                    <strong>{tab}</strong>
                    <select aria-label={`${tab} icon`} value={config.navigation.icons?.[tab] ?? tab}
                      onChange={(e) => update((c) => {
                        c.navigation.icons = { ...c.navigation.icons, [tab]: e.target.value as NonNullable<MobileConfig["navigation"]["icons"]>[string] };
                      })}>
                      {["home", "categories", "deals", "cart", "account", "wishlist", "location"].map((icon) => <option key={icon} value={icon}>{icon}</option>)}
                    </select>
                    <button
                      aria-label={`Move ${tab} tab up`}
                      disabled={i === 0}
                      onClick={() =>
                        update((c) => {
                          c.navigation.tabs.splice(
                            i - 1,
                            0,
                            c.navigation.tabs.splice(i, 1)[0],
                          );
                        })
                      }
                    >
                      ↑
                    </button>
                    <button
                      aria-label={`Move ${tab} tab down`}
                      disabled={i === config.navigation.tabs.length - 1}
                      onClick={() =>
                        update((c) => {
                          c.navigation.tabs.splice(
                            i + 1,
                            0,
                            c.navigation.tabs.splice(i, 1)[0],
                          );
                        })
                      }
                    >
                      ↓
                    </button>
                    {!["home", "cart", "account"].includes(tab) && (
                      <button
                        aria-label={`Remove ${tab} tab`}
                        onClick={() =>
                          update((c) => {
                            if (c.navigation.icons) delete c.navigation.icons[tab];
                            c.navigation.tabs = c.navigation.tabs.filter(
                              (t) => t !== tab,
                            );
                          })
                        }
                      >
                        ×
                      </button>
                    )}
                  </div>
                ))}
                {(["categories", "deals", "wishlist"] as const)
                  .filter((t) => !config.navigation.tabs.includes(t))
                  .map((t) => (
                    <button
                      key={t}
                      disabled={config.navigation.tabs.length >= 5 || (t === "wishlist" && !config.features.wishlist)}
                      onClick={() =>
                        update((c) => {
                          c.navigation.tabs.push(t);
                        })
                      }
                    >
                      Add {t} tab
                    </button>
                  ))}
              </fieldset>
            )}
            {panel === "Features" && (
              <fieldset disabled={!designable || locked}>
                <legend>Product screen actions</legend>
                {import.meta.env.VITE_PRODUCT_SCREEN_CONTROLS_ENABLED === "false" && <p className="ms-help">Product icon visibility settings are not available on this deployment yet. You can still manage wishlist access below.</p>}
                {(["showWishlist", "showCompare"] as const).map(key => <label className="ms-check" key={key}>
                  <input type="checkbox" disabled={import.meta.env.VITE_PRODUCT_SCREEN_CONTROLS_ENABLED === "false"} checked={config.screens.product?.[key] !== false}
                    onChange={event => update(c => { c.screens.product = { ...c.screens.product, [key]: event.target.checked }; })} />
                  <span>{key === "showWishlist" ? "Show wishlist icon on products" : "Show compare icon on products"}</span>
                </label>)}
                {(
                  Object.keys(
                    config.features,
                  ) as (keyof MobileConfig["features"])[]
                ).map((f) => (
                  <label className="ms-check" key={f}>
                    <input
                      type="checkbox"
                      checked={config.features[f]}
                      disabled={
                        !merchant.entitlements[f] && !config.features[f]
                      }
                      onChange={(e) =>
                        update((c) => {
                          c.features[f] = e.target.checked;
                        })
                      }
                    />
                    <span>
                      <strong>
                        {f === "locationPicker" ? "Location picker" : f}
                      </strong>
                      <small>
                        {merchant.entitlements[f]
                          ? "Enabled by your merchant plan"
                          : "Unavailable in your merchant plan"}
                      </small>
                    </span>
                  </label>
                ))}
                <p className="ms-help">
                  Checkout, payments, loyalty and AI controls will appear when
                  supported by the native runtime and merchant entitlements.
                </p>
              </fieldset>
            )}
            {panel === "Languages" && (
              <fieldset disabled={!designable || locked}>
                <Field label="Default language">
                  <select
                    value={config.localization.defaultLocale}
                    onChange={(e) =>
                      update((c) => {
                        c.localization.defaultLocale = e.target.value as
                          | "en"
                          | "ar";
                      })
                    }
                  >
                    <option value="en">English</option>
                    <option value="ar">Arabic</option>
                  </select>
                </Field>
                {(["en", "ar"] as const).map((l) => (
                  <label className="ms-check" key={l}>
                    <input
                      type="checkbox"
                      checked={config.localization.supportedLocales.includes(l)}
                      onChange={(e) =>
                        update((c) => {
                          c.localization.supportedLocales = e.target.checked
                            ? [...c.localization.supportedLocales, l]
                            : c.localization.supportedLocales.filter(
                                (x) => x !== l,
                              );
                        })
                      }
                    />
                    {l === "en" ? "English" : "Arabic"}
                  </label>
                ))}
                <label className="ms-check">
                  <input
                    type="checkbox"
                    checked={config.localization.rtlEnabled}
                    onChange={(e) =>
                      update((c) => {
                        c.localization.rtlEnabled = e.target.checked;
                      })
                    }
                  />
                  Enable right-to-left layout
                </label>
                {[
                  ...new Set([
                    ...Object.keys(config.localization.messages.en || {}),
                    ...Object.keys(config.localization.messages.ar || {}),
                  ]),
                ].map((key) => (
                  <div className="ms-translation" key={key}>
                    <code>{key}</code>
                    {(["en", "ar"] as const).map((l) => (
                      <Field
                        key={l}
                        label={`${key} · ${l === "en" ? "English" : "Arabic"}`}
                      >
                        <input
                          dir={l === "ar" ? "rtl" : "ltr"}
                          lang={l}
                          value={config.localization.messages[l]?.[key] || ""}
                          maxLength={2000}
                          onChange={(e) =>
                            update((c) => {
                              c.localization.messages[l] = {
                                ...c.localization.messages[l],
                                [key]: e.target.value,
                              };
                            })
                          }
                        />
                      </Field>
                    ))}
                  </div>
                ))}
              </fieldset>
            )}
            {panel === "Assets" && <MobileAssets key={`${merchant.id}:${env}`} assets={assets} config={config}
              merchant={merchant.id} environment={env} disabled={!designable || locked || saving || busy}
              selectLogo={asset => { setAssets(previous => previous.some(a => a.id === asset.id) ? previous : [asset, ...previous]); update(c => { c.brand.logoAssetId = asset.id; }); }}
              assetChanged={asset => setAssets(previous => previous.map(a => a.id === asset.id ? asset : a))}
              upload={async (name, file, folderId) => {
                let succeeded = false;
                await command(async () => {
                  const asset = await mobileApi.upload(merchant.id, env, name, file, folderId);
                  setAssets(previous => [asset, ...previous]);
                  setNotice(`${asset.name} uploaded. Select it as a logo or banner.`);
                  if (config.brand.logoAssetId === EMPTY_ASSET) update(c => { if (c.brand.logoAssetId === EMPTY_ASSET) c.brand.logoAssetId = asset.id; });
                  succeeded = true;
                });
                return succeeded;
              }} />}
            {panel === "Release history" && (
              <>
                <h3>{env} releases</h3>
                {versions.length === 0 && <p>No releases published yet.</p>}
                {versions.map((v, i) => (
                  <article className="ms-history" key={v.version}>
                    <strong>
                      Version {v.version} {i === 0 ? "· Live" : ""}
                    </strong>
                    <small>{new Date(v.publishedAt).toLocaleString()}</small>
                    <p>
                      Published by <code>{v.publishedBy}</code>
                    </p>
                    {v.rollbackTarget && (
                      <p>Previous live version: v{v.rollbackTarget}</p>
                    )}
                    <details>
                      <summary>Release changes</summary>
                      <Diff
                        changes={configDiff(versions[i + 1]?.config, v.config)}
                      />
                      <p className="ms-help">
                        Compared with the preceding loaded release.
                      </p>
                    </details>
                    {designable && (
                      <button
                        disabled={locked || saving}
                        onClick={() => {
                          if (
                            !dirty ||
                            window.confirm(
                              "Replace your unsaved changes with this release?",
                            )
                          )
                            change(asDraft(v.config));
                        }}
                      >
                        Copy to draft
                      </button>
                    )}
                    {owner && i > 0 && (
                      <button
                        disabled={!base || dirty || locked || saving}
                        onClick={() =>
                          openReview({ kind: "rollback", version: v })
                        }
                      >
                        Review rollback to v{v.version}
                      </button>
                    )}
                  </article>
                ))}
                {moreVersions && (
                  <button
                    disabled={busy}
                    onClick={() => void loadMore("versions")}
                  >
                    Load more releases
                  </button>
                )}
                <h3>Audit trail</h3>
                <p className="ms-help">
                  {merchant.name} · {env}
                </p>
                {audit.map((a) => (
                  <article className="ms-history" key={a.id}>
                    <strong>{a.action}</strong>
                    <small>{new Date(a.createdAt).toLocaleString()}</small>
                    <p>
                      Actor <code>{a.actorId}</code>
                    </p>
                    <details>
                      <summary>Event details</summary>
                      {a.action === "config.draft_saved" ? (
                        <Diff
                          changes={configDiff(
                            a.details.before,
                            a.details.after,
                          )}
                        />
                      ) : (
                        <pre>{JSON.stringify(a.details, null, 2)}</pre>
                      )}
                    </details>
                  </article>
                ))}
                {moreAudit && (
                  <button
                    disabled={busy}
                    onClick={() => void loadMore("audit")}
                  >
                    Load more audit events
                  </button>
                )}
              </>
            )}
            </section>
          </div>
        </aside>
        <section className="ms-preview-area" hidden={panel !== "Native Preview"} aria-label="Native simulator preview" ref={setPreviewContainer} />
      </div>
      {review && (
        <dialog
          className="ms-dialog"
          ref={dialog}
          aria-labelledby="mobile-publish-title"
          onCancel={(e) => {
            e.preventDefault();
            if (!busy) setReview(undefined);
          }}
        >
          <h2 id="mobile-publish-title">
            {review.kind === "rollback"
              ? `Restore version ${review.version!.version}`
              : `Publish to ${env}`}
          </h2>
          <p>
            {merchant.name} · Draft revision {base?.revision}.{" "}
            {review.kind === "rollback"
              ? "This creates a new immutable release from the selected version."
              : "Your current saved draft will become an immutable release."}
          </p>
          <Diff changes={diff} />
          <p className="ms-help">
            {review.kind === "rollback"
              ? "The backend rechecks compatibility, assets and entitlements."
              : "Your saved draft is checked again before publication. Review the preview and confirm your changes."}{" "}
            Color and layout changes do not require a store build.
          </p>
          <label className="ms-check">
            <input
              type="checkbox"
              checked={approved}
              disabled={busy}
              onChange={(e) => setApproved(e.target.checked)}
            />
            I approve these changes for {env}
            {env === "production"
              ? " and have verified the release in both native apps"
              : ""}
            .
          </label>
          {error && (
            <p role="alert" className="ms-error">
              {error}
            </p>
          )}
          <Issues issues={serverIssues} />
          <div className="ms-actions">
            <button disabled={busy} onClick={() => setReview(undefined)}>
              Cancel
            </button>
            <button
              className="ms-primary"
              disabled={!approved || busy || conflict}
              onClick={() => void publish()}
            >
              {busy
                ? "Publishing…"
                : review.kind === "rollback"
                  ? "Confirm rollback"
                  : `Publish to ${env}`}
            </button>
          </div>
        </dialog>
      )}
    </>
  );
}
function SectionFields({
  section,
  config,
  assets,
  patch,
}: {
  section: MobileSection;
  config: MobileConfig;
  assets: MobileAsset[];
  patch: (props: Partial<MobileSection["props"]>) => void;
}) {
  const p = section.props;
  const keys = [
    ...new Set([
      ...Object.keys(config.localization.messages.en || {}),
      ...Object.keys(config.localization.messages.ar || {}),
    ]),
  ];
  const translation = (
    label: string,
    key: "titleKey" | "textKey" | "accessibilityLabelKey",
    value: string,
  ) => (
    <Field label={label}>
      <select value={value} onChange={(e) => patch({ [key]: e.target.value })}>
        {keys.map((k) => (
          <option key={k} value={k}>
            {k}
          </option>
        ))}
      </select>
    </Field>
  );
  return (
    <>
      {section.type !== "spacer" && <details className="ms-translation-reference"><summary>Advanced: translation references</summary>
      {"titleKey" in p &&
        translation("Title translation", "titleKey", p.titleKey)}
      {"textKey" in p && translation("Text translation", "textKey", p.textKey)}
      {"accessibilityLabelKey" in p &&
        translation(
          "Accessible label translation",
          "accessibilityLabelKey",
          p.accessibilityLabelKey,
        )}
      </details>}
      {section.type === "productCarousel" && <p className="ms-help">Shoppers swipe through products from the selected source. The product limit is the maximum shown; fewer appear when fewer products are available.</p>}
      {"collectionId" in p && <MobileFeedPicker merchant={config.tenantId} value={p.collectionId} change={collectionId => patch({ collectionId })} />}
      {("collectionId" in p) && <Field label="Product limit"><input type="number" min={1} max={24} value={p.limit ?? 24} onChange={e=>patch({limit:Number(e.target.value)})}/></Field>}
      {"columns" in p && (
        <Field label="Columns">
          <select
            value={p.columns}
            onChange={(e) => patch({ columns: Number(e.target.value) })}
          >
            <option value={1}>1</option>
            <option value={2}>2</option>
          </select>
        </Field>
      )}
      {"categoryIds" in p && <MobileCategoryPicker merchant={config.tenantId} label="Displayed categories" values={p.categoryIds} multiple change={categoryIds => patch({ categoryIds })} />}
      {"size" in p && (
        <Field label="Space size">
          <select
            value={p.size}
            onChange={(e) =>
              patch({ size: e.target.value as "small" | "medium" | "large" })
            }
          >
            <option>small</option>
            <option>medium</option>
            <option>large</option>
          </select>
        </Field>
      )}
      {section.type === "heroBanner" && <MobileBannerSettings key={section.id} section={section} merchant={config.tenantId} assets={assets} patch={patch} />}
      {"action" in p && p.action && (
        <ActionFields
          action={p.action}
          merchant={config.tenantId}
          tabs={config.navigation.tabs}
          change={(action) => patch({ action })}
        />
      )}
    </>
  );
}
function ActionFields({
  merchant,
  action,
  tabs,
  change,
}: {
  merchant: string;
  action: MobileAction;
  tabs: MobileConfig["navigation"]["tabs"];
  change: (a: MobileAction) => void;
}) {
  return (
    <>
      <Field label="Banner action">
        <select
          value={action.type}
          onChange={(e) =>
            change(
              e.target.value === "openTab"
                ? { type: "openTab", tab: "home" }
                : e.target.value === "openCategory"
                  ? { type: "openCategory", categoryId: "featured" }
                  : { type: "openProduct", productId: "product" },
            )
          }
        >
          <option value="openTab">Open tab</option>
          <option value="openCategory">Open category</option>
          <option value="openProduct">Open product</option>
        </select>
      </Field>
      {action.type === "openTab" ? (
        <Field label="Target tab">
          <select
            value={action.tab}
            onChange={(e) =>
              change({
                type: "openTab",
                tab: e.target.value as typeof action.tab,
              })
            }
          >
            {tabs.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </Field>
      ) : action.type === "openCategory" ? (
        <MobileCategoryPicker merchant={merchant} label="Destination category" values={[action.categoryId]} change={ids => change({ type: "openCategory", categoryId: ids[0] })} />
      ) : (
        <Field
          label="Product ID"
        >
          <input
            value={action.productId}
            onChange={(e) =>
              change(
                { ...action, productId: e.target.value },
              )
            }
          />
        </Field>
      )}
    </>
  );
}
function Diff({ changes }: { changes: ReturnType<typeof configDiff> }) {
  return (
    <div className="ms-diff">
      {changes.length === 0 ? (
        <p>No content changes.</p>
      ) : (
        changes.map((c, i) => (
          <div key={i}>
            <code>{c.path}</code>
            <del>{c.before}</del>
            <ins>{c.after}</ins>
          </div>
        ))
      )}
    </div>
  );
}
