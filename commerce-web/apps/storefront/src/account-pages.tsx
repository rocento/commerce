import { useInterface } from './interface-locale';
import { useAuth } from './auth-context';
import { ProfileEditor } from './product-types';
import { DeliveryFields, emptyDelivery } from './locations';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { customerApi, locationAddress, type LocationInput, type Location } from '@commerce/api-client';
import { Field, Notice, useAction } from '@commerce/ui';
import './account.css';

export function AuthForm({ mode }: { mode: "login" | "register" }) {
  const { message } = useInterface();
  const { t: ui } = useInterface();
  const { customer, setCustomer } = useAuth();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const a = useAction();
  if (customer)
    return (
      <Navigate
        to={params.get("next") === "checkout" ? "/checkout" : "/account"}
        replace
      />
    );
  async function submit(e: FormEvent) {
    e.preventDefault();
    await a.run(async () => {
      if (mode === "register") {
        await customerApi.register(identifier, password);
        nav(
          "/verify?identifier=" +
            encodeURIComponent(identifier) +
            "&next=" +
            (params.get("next") === "checkout" ? "checkout" : "account"),
        );
      } else {
        setCustomer(await customerApi.login(identifier, password));
        nav(
          params.get("next") === "checkout"
            ? "/checkout"
            : params.get("next") === "cart"
              ? "/cart"
              : "/account",
        );
      }
    });
  }
  return (
    <main className="auth-layout">
      <section className={`form-card auth-card${mode === "register" ? " signup-card" : ""}`}>
        <h1>{mode === "login" ? ui("storefront.login", "Login") : ui("storefront.sign_up", "Sign up")}</h1>
        <p className="muted">
          {mode === "login"
            ? ui("storefront.enter_your_email_and_password_to_login", "Enter your email and password to login:")
            : ui("storefront.please_fill_in_the_information_below", "Please fill in the information below:")}
        </p>
        <form onSubmit={submit}>
          <Field
            label={ui("storefront.e_mail", "E-mail")}
            placeholder={mode === "register" ? "E-mail" : undefined}
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            autoComplete="username"
            required
            maxLength={254}
          />
          <Field
            label={ui("storefront.password", "Password")}
            placeholder={mode === "register" ? "Password" : undefined}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={mode === "register" ? 12 : undefined}
            maxLength={128}
            autoComplete={
              mode === "login" ? "current-password" : "new-password"
            }
          />
          {mode === "register" && (
            <p className="help">{ui("storefront.use_at_least_12_characters", "Use at least 12 characters.")}</p>
          )}
          <Notice error>{message((a.error) || '')}</Notice>
          <button disabled={a.busy}>
            {a.busy
              ? ui("storefront.please_wait", "Please wait…")
              : mode === "login"
                ? ui("storefront.login", "Login")
                : ui("storefront.create_account", "Create account")}
          </button>
        </form>
        {mode === "login" ? (
          <>
            <Link to="/forgot-password">{ui("storefront.forgot_your_password", "Forgot your password?")}</Link>
            <p>
              {ui("storefront.don_t_have_an_account", "Don't have an account?")}{" "}
              <Link to={"/register?next=" + (params.get("next") || "account")}>
                {ui("storefront.sign_up", "Sign up")} </Link>
            </p>
          </>
        ) : (
          <p>
            {ui("storefront.already_have_an_account", "Already have an account?")}{" "}
            <Link to={"/login?next=" + (params.get("next") || "account")}>
              {ui("storefront.login", "Login")} </Link>
          </p>
        )}
      </section>
    </main>
  );
}
export function Challenge({ mode }: { mode: "verify" | "forgot" | "reset" }) {
  const queryClient = useQueryClient();
  const { message } = useInterface();
  const { t: ui } = useInterface();
  const [params] = useSearchParams();
  const [identifier, setIdentifier] = useState(params.get("identifier") || "");
  const [token, setToken] = useState(params.get("token") || "");
  const [password, setPassword] = useState("");
  const [done, setDone] = useState(false);
  const a = useAction();
  const { setCustomer } = useAuth();
  const title =
    mode === "verify"
      ? "Verify your account"
      : mode === "forgot"
        ? "Forgot your password?"
        : "Set a new password";
  return (
    <main className="narrow">
      <section className="form-card">
        <p className="eyebrow">{ui("storefront.account_security", "ACCOUNT SECURITY")}</p>
        <h1>{title}</h1>
        <p className="muted">
          {mode === "forgot"
            ? "Enter your email or mobile number to request a reset link or code."
            : "Use the link sent to your email or the six-digit code sent to your mobile."}
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void a.run(async () => {
              if (mode === "verify") {
                await customerApi.verify(identifier, token);
                await queryClient.invalidateQueries({ queryKey: ["profile"] });
              } else if (mode === "forgot")
                await customerApi.forgot(identifier);
              else {
                await customerApi.reset(identifier, token, password);
                queryClient.clear();
                setCustomer(null);
              }
              setDone(true);
              a.setMessage(
                mode === "verify"
                  ? "Your account is verified. You can now sign in."
                  : mode === "forgot"
                    ? "If this account exists, a reset link or code has been sent."
                    : "Password updated. Sign in with your new password.",
              );
            });
          }}
        >
          <Field
            label={ui("storefront.email_or_mobile_number", "Email or mobile number")}
            required
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            autoComplete="username"
          />
          {mode !== "forgot" && (
            <Field
              label={ui("storefront.verification_code_or_token", "Verification code or token")}
              required
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="one-time-code"
              maxLength={128}
            />
          )}{" "}
          {mode === "reset" && (
            <Field
              label={ui("storefront.new_password", "New password")}
              type="password"
              required
              minLength={12}
              maxLength={128}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
            />
          )}
          <Notice error>{message((a.error) || '')}</Notice>
          <Notice>{message((a.message) || '')}</Notice>
          <button disabled={a.busy || done}>
            {a.busy
              ? ui("storefront.please_wait", "Please wait…")
              : mode === "forgot"
                ? ui("storefront.send_reset_instructions", "Send reset instructions")
                : mode === "verify"
                  ? ui("storefront.verify_account", "Verify account")
                  : ui("storefront.update_password", "Update password")}
          </button>
        </form>
        {mode === "verify" && (
          <button
            className="text-button"
            disabled={a.busy}
            onClick={() =>
              a.run(async () => {
                await customerApi.requestVerification(identifier);
                a.setMessage(
                  "If verification is needed, a new link or code has been sent.",
                );
              })
            }
          >
            {ui("storefront.resend_verification", "Resend verification")} </button>
        )}
        {mode === "forgot" && done && (
          <Link
            to={"/reset-password?identifier=" + encodeURIComponent(identifier)}
          >
            {ui("storefront.enter_reset_code", "Enter reset code")} <span className="direction-icon" aria-hidden="true">→</span>
          </Link>
        )}
        <Link to={"/login?next=" + (params.get("next") || "account")}>
          {ui("storefront.continue_to_sign_in", "Continue to sign in")} </Link>
      </section>
    </main>
  );
}
export function Account() {
  const { message } = useInterface();
  const { t: ui } = useInterface();
  const { customer } = useAuth();
  const profile = useQuery({ queryKey: ["profile"], queryFn: customerApi.me });
  const current = profile.data || customer;
  return (
    <main className="account-overview">
      <p className="eyebrow">{ui("storefront.my_account", "MY ACCOUNT")}</p>
      <h1>{ui("storefront.your_details_in_one_place", "Your details, in one place.")}</h1>
      <Notice error>{message((profile.error?.message) || '')}</Notice>
      <section className="account-card account-verification" data-verified={!!current?.verified}>
        <div>
          <h2>{current?.email || current?.mobile_number}</h2>
          <span className={`badge ${current?.verified ? "success" : ""}`}>
            {current?.verified ? ui("storefront.verified_account", "Verified account") : ui("storefront.verification_needed", "Verification needed")}
          </span>
        </div>
        {!current?.verified && (
          <Link
            to={
              "/verify?identifier=" +
              encodeURIComponent(current?.email || current?.mobile_number || "")
            }
          >
            {ui("storefront.verify_account", "Verify account")} <span className="direction-icon" aria-hidden="true">→</span>
          </Link>
        )}
      </section>
      {current&&<ProfileEditor key={current.id} customerId={current.id}/>}
    </main>
  );
}
export function AccountFrame({ children }: { children: ReactNode }) {
  const { t: ui } = useInterface();
  const { customer } = useAuth();
  const { pathname } = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => { setMenuOpen(false); }, [pathname]);
  const isOverview = pathname === "/account";
  const identity = customer?.email || customer?.mobile_number || ui("navigation.account", "My account");
  const navigation = [
    [ui("storefront.account_overview", "Overview"), "/account"],
    [ui("storefront.account_orders", "Orders"), "/account/orders"],
    [ui("storefront.saved_locations", "Saved locations"), "/account/locations"],
    [ui("navigation.wishlist", "Wishlist"), "/account/wishlist"],
    [ui("storefront.account_support_requests", "Support requests"), "/account/tickets"],
  ];
  const icons = ["M3 10 12 3l9 7M5 9v12h5v-7h4v7h5V9", "M5 3h14v18l-3-2-4 2-4-2-3 2V3M8 8h8M8 12h8", "M20 10c0 6-8 11-8 11S4 16 4 10a8 8 0 1 1 16 0ZM15 10a3 3 0 1 1-6 0 3 3 0 0 1 6 0", "M20 5c-3-3-7-1-8 1-1-2-5-4-8-1-4 4 1 9 8 15 7-6 12-11 8-15Z", "M4 13v-2a8 8 0 0 1 16 0v2M4 12H2v6h4v-6H4M20 12h2v6h-4v-6h2M20 18c0 3-4 3-8 3"];
  const activeLabel = navigation.find(([, to]) => pathname === to || to !== "/account" && pathname.startsWith(`${to}/`))?.[0] || ui("navigation.account", "My account");
  return <div className="account-workspace" data-overview={isOverview} data-menu-open={menuOpen}>
    <aside className="account-sidebar" aria-label={ui("storefront.account_navigation", "Account navigation")}>
      <div className="account-mobile-heading">
        {isOverview ? <h1>{ui("navigation.account", "My account")}</h1> : <Link to="/account"><span className="direction-icon" aria-hidden="true">←</span>  {ui("navigation.account", "My account")}</Link>}
        {!isOverview && <button type="button" className="text-button account-menu-toggle" aria-expanded={menuOpen} aria-controls="account-section-navigation" onClick={() => setMenuOpen(!menuOpen)}>{activeLabel}<span aria-hidden="true">{menuOpen ? "−" : "+"}</span></button>}
      </div>
      <div className="account-identity">
        <span className="account-avatar" aria-hidden="true">{identity.slice(0, 1).toUpperCase()}</span>
        <div><strong>{identity}</strong><span>{customer?.verified ? ui("storefront.verified_account", "Verified account") : ui("storefront.account_verification_needed", "Account verification needed")}</span></div>
      </div>
      <nav id="account-section-navigation" className="account-navigation" aria-label={ui("navigation.account", "My account")}>
        {navigation.map(([label, to], index) => {
          const active = pathname === to || to !== "/account" && pathname.startsWith(`${to}/`);
          return <Link key={to} to={to} aria-current={active ? "page" : undefined}><svg className="account-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={icons[index]}/></svg><span>{label}</span><span className="account-nav-chevron" aria-hidden="true">›</span></Link>;
        })}
      </nav>
      <Link className="account-support-link" to="/support">{ui("storefront.need_help_contact_support", "Need help? Contact support")}</Link>
    </aside>
    <div className="account-content">{children}</div>
  </div>;
}

export function Locations() {
  const { message } = useInterface();
  const { t: ui } = useInterface();
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: ["locations"],
    queryFn: customerApi.locations,
  });
  const client = useQueryClient();
  const [editing, setEditing] = useState<string | undefined>();
  const [show, setShow] = useState(false);
  const [form, setForm] = useState<LocationInput>({ ...emptyDelivery });
  const [deleting, setDeleting] = useState<string | null>(null);
  const a = useAction();
  const edit = (l: Location) => {
    setEditing(l.id);
    setForm({
      location_method: l.location_method ?? "pin",
      geography: l.geography,
      label: l.label,
      custom_label: l.custom_label,
      latitude: l.latitude,
      longitude: l.longitude,
      formatted_address: l.formatted_address,
      building: l.building,
      floor: l.floor,
      apartment: l.apartment,
      delivery_instructions: l.delivery_instructions,
      is_default: l.is_default,
    });
    setShow(true);
  };
  return (
    <main>
      <Link to="/account"><span className="direction-icon" aria-hidden="true">←</span>  {ui("navigation.account", "My account")}</Link>
      <div className="page-heading">
        <div>
          <p className="eyebrow">{ui("storefront.your_places", "YOUR PLACES")}</p>
          <h1>{ui("storefront.saved_locations", "Saved locations")}</h1>
        </div>
        <button
          onClick={() => navigate("/account/locations/new")}
        >
          {ui("storefront.add_location", "Add location")} </button>
      </div>
      <Notice error>{message((a.error || q.error?.message) || '')}</Notice>
      {q.isPending ? (
        <p role="status">{ui("storefront.loading_locations", "Loading locations…")}</p>
      ) : q.data?.length === 0 ? (
        <section className="empty-state">
          <h2>{ui("storefront.where_should_we_deliver", "Where should we deliver?")}</h2>
          <p>{ui("account.add_your_first_location_and_keep_the_little_details_ready", "Add your first location and keep the little details ready.")}</p>
        </section>
      ) : (
        <div className="location-list">
          {q.data?.map((l) => (
            <article key={l.id} className="location-card">
              <div className="location-card-header">
                <div className="location-card-title">
                  <h2>
                    {l.label === "other"
                      ? l.custom_label
                      : l.label === "home"
                        ? ui("navigation.home", "Home")
                        : ui("storefront.work", "Work")}
                  </h2>
                  {l.is_default && <span className="badge success">{ui("storefront.default", "Default")}</span>}
                </div>
                <div className="location-card-tools">
                  <button type="button" className="icon-button location-icon-button" aria-label={ui("common.edit", "Edit")} title={ui("common.edit", "Edit")} onClick={() => edit(l)}>
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m16 3 5 5M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15l-1 6Z" /></svg>
                  </button>
                  <button type="button" className="icon-button location-icon-button location-icon-remove" aria-label={ui("common.remove", "Remove")} title={ui("common.remove", "Remove")} disabled={a.busy} onClick={() => setDeleting(l.id)}>
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" /></svg>
                  </button>
                </div>
              </div>
              <p className="location-card-address">{locationAddress(l)}</p>

              <p className="muted location-card-unit">
                {[
                  l.building,
                  l.floor && ui("account.floor_floor", "Floor {floor}", {floor:l.floor}),
                  l.apartment && ui("account.apt_apartment", "Apt {apartment}", {apartment:l.apartment}),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
              {l.delivery_instructions && <p className="location-card-instructions">{l.delivery_instructions}</p>}
              <div className="row location-card-actions">
                {!l.is_default && (
                  <button
                    className="text-button"
                    disabled={a.busy}
                    onClick={() =>
                      a.run(async () => {
                        await customerApi.saveLocation(
                          {
                            location_method: l.location_method ?? "pin",
                            geography: l.geography,
                            label: l.label,
                            custom_label: l.custom_label,
                            latitude: l.latitude,
                            longitude: l.longitude,
                            formatted_address: l.formatted_address,
                            building: l.building,
                            floor: l.floor,
                            apartment: l.apartment,
                            delivery_instructions: l.delivery_instructions,
                            is_default: true,
                          },
                          l.id,
                        );
                        await client.invalidateQueries({
                          queryKey: ["locations"],
                        });
                      })
                    }
                  >
                    {ui("storefront.make_default", "Make default")} </button>
                )}
              </div>
              {deleting === l.id && (
                <div className="notice">
                  <p>{ui("storefront.remove_this_saved_location", "Remove this saved location?")}</p>
                  <button
                    disabled={a.busy}
                    onClick={() =>
                      a.run(async () => {
                        await customerApi.deleteLocation(l.id);
                        setDeleting(null);
                        await client.invalidateQueries({
                          queryKey: ["locations"],
                        });
                      })
                    }
                  >
                    {ui("storefront.remove_location", "Remove location")} </button>{" "}
                  <button
                    className="secondary"
                    onClick={() => setDeleting(null)}
                  >
                    {ui("storefront.keep_it", "Keep it")} </button>
                </div>
              )}
            </article>
          ))}
        </div>
      )}
      {show && (
        <section className="form-card location-form">
          <h2>{editing ? ui("storefront.edit_location", "Edit location") : ui("storefront.add_a_location", "Add a location")}</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void a.run(async () => {
                await customerApi.saveLocation(form, editing);
                setShow(false);
                await client.invalidateQueries({ queryKey: ["locations"] });
              });
            }}
          >
            <DeliveryFields value={form} onChange={setForm} />
            <Notice error>{message((a.error) || '')}</Notice>
            <div className="row">
              <button disabled={a.busy}>
                {a.busy ? ui("storefront.saving", "Saving…") : ui("storefront.save_location", "Save location")}
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => setShow(false)}
              >
                {ui("common.cancel", "Cancel")} </button>
            </div>
          </form>
        </section>
      )}
    </main>
  );
}
export function NewLocation() {
  const { message } = useInterface();
  const { t: ui } = useInterface();
  const navigate = useNavigate();
  const client = useQueryClient();
  const action = useAction();
  const [form, setForm] = useState<LocationInput>({ ...emptyDelivery });
  return (
    <main className="location-editor-page">
      <Link to="/account/locations" className="back-link"><span className="direction-icon" aria-hidden="true">←</span>  {ui("storefront.saved_locations", "Saved locations")}</Link>
      <div className="location-editor-heading">
        <p className="eyebrow">{ui("storefront.delivery_details", "DELIVERY DETAILS")}</p>
        <h1>{ui("storefront.add_a_new_location", "Add a new location")}</h1>
        <p>{ui("account.enter_the_details_once_so_every_delivery_reaches_the_right_door", "Enter the details once, so every delivery reaches the right door.")}</p>
      </div>
      <section className="location-editor-card">
        <form onSubmit={(e) => { e.preventDefault(); void action.run(async () => { await customerApi.saveLocation(form); await client.invalidateQueries({ queryKey: ["locations"] }); navigate("/account/locations"); }); }}>
          <DeliveryFields value={form} onChange={setForm} />
          <Notice error>{message((action.error) || '')}</Notice>
          <div className="location-editor-actions">
            <button disabled={action.busy}>{action.busy ? ui("storefront.saving", "Saving…") : ui("storefront.save_location", "Save location")}</button>
            <Link className="secondary button-link" to="/account/locations">{ui("common.cancel", "Cancel")}</Link>
          </div>
        </form>
      </section>
    </main>
  );
}
