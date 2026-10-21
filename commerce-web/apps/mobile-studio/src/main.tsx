import React, { useEffect, useState, type FormEvent } from "react";
import ReactDOM from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { adminApi, ApiError, type AdminIdentity } from "@commerce/api-client";
import { MobileStudio } from "./mobile-studio";
import { RocentoBrand } from "./rocento-brand";
import "./style.css";
function App() {
  const [identity, setIdentity] = useState<AdminIdentity>();
  const [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    adminApi
      .me()
      .then((v) => {
        if (live) setIdentity(v);
      })
      .catch((e) => {
        if (live && !(e instanceof ApiError && e.status === 401))
          setError("Unable to reach Mobile App Studio. Refresh to retry.");
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, []);
  async function login(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      setIdentity(await adminApi.login(email, password));
      setPassword("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to sign in");
    } finally {
      setBusy(false);
    }
  }
  async function logout() {
    await adminApi.logout();
    setIdentity(undefined);
  }
  if (loading)
    return (
      <main className="ms-loading" role="status">
        Opening Mobile App Studio…
      </main>
    );
  if (identity)
    return (
      <MobileStudio
        key={String(identity.user.id)}
        identity={identity}
        logout={logout}
      />
    );
  return (
    <main className="ms-login">
      <section className="ms-login-story">
        <RocentoBrand />
        <p className="ms-eyebrow">MOBILE APP STUDIO</p>
        <h1>
          Your store.
          <br />
          In their pocket.
        </h1>
        <p>
          Shape one shopping experience for iOS and Android. From the first
          impression to the next release.
        </p>
        <div className="ms-login-art" aria-hidden="true">
          <div>
            ◒<span>Your next chapter</span>
            <i />
            <i />
          </div>
          <div>
            ◇<span>Made for your brand</span>
            <i />
            <i />
          </div>
        </div>
        <small>apps.rocento.com · Merchant mobile workspace</small>
      </section>
      <section className="ms-login-form">
        <p className="ms-eyebrow">WELCOME BACK</p>
        <h2>Sign in to App Studio</h2>
        <p>Use your mobile merchant account to continue.</p>
        <form onSubmit={login}>
          <label>
            Work email
            <input
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label>
            Password
            <input
              type="password"
              autoComplete="current-password"
              required
              maxLength={128}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {error && (
            <p role="alert" className="ms-error">
              {error}
            </p>
          )}
          <button className="ms-primary" disabled={busy}>
            {busy ? "Signing in…" : "Sign in to App Studio"}
          </button>
        </form>
        <small>
          Access is managed through your mobile merchant membership.
        </small>
      </section>
    </main>
  );
}
const router = createBrowserRouter([{ path: "*", element: <App /> }]);
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
