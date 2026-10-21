"use strict";
// Only this fixed, same-origin GET uses the existing HttpOnly admin session.
// Swagger receives an in-memory spec and cannot execute requests or accept keys.
const schemaUrl = "/api/v1/admin/api-reference/openapi.json";
const status = document.getElementById("reference-status");
const container = document.getElementById("swagger-ui");
let request;
let generation = 0;
function clearReference(message) {
  generation += 1;
  request?.abort();
  container.replaceChildren();
  status.hidden = false;
  status.textContent = message;
}
async function loadReference() {
  clearReference("Checking documentation access…");
  const current = generation;
  request = new AbortController();
  try {
    const response = await fetch(schemaUrl, {
      method: "GET", credentials: "same-origin", cache: "no-store",
      redirect: "error", headers: { Accept: "application/json" }, signal: request.signal,
    });
    if (current !== generation) return;
    if (response.status === 401 || response.status === 403) {
      status.textContent = response.status === 401
        ? "Sign in to your store administration, then reopen this reference."
        : "Your role does not have API documentation access. Ask your administrator for the View API documentation permission.";
      return;
    }
    if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) throw new Error("Unavailable reference");
    const spec = await response.json();
    if (current !== generation) return;
    if (spec.openapi !== "3.0.3" || !spec.paths || !spec.info) throw new Error("Invalid reference");
    SwaggerUIBundle({
      dom_id: "#swagger-ui", spec, layout: "BaseLayout", filter: true,
      deepLinking: true, docExpansion: "list", defaultModelsExpandDepth: -1,
      supportedSubmitMethods: [], tryItOutEnabled: false, validatorUrl: null,
      queryConfigEnabled: false, persistAuthorization: false, withCredentials: false,
      plugins: [() => ({ components: { authorizeBtn: () => null, authorizeOperationBtn: () => null } })],
      requestInterceptor() { throw new Error("This reference does not execute API requests."); },
      onComplete() { if (current === generation) status.hidden = true; },
    });
  } catch (error) {
    if (current !== generation || error.name === "AbortError") return;
    clearReference("The API reference is unavailable. Reload the page to check your access again.");
  }
}
// Re-check the server after history restoration or returning to a hidden tab.
// Private contracts are never persisted in storage, a service worker or URLs.
window.addEventListener("pagehide", () => clearReference("Checking documentation access…"));
window.addEventListener("pageshow", () => { if (!document.hidden) void loadReference(); });
document.addEventListener("visibilitychange", () => {
  if (document.hidden) clearReference("Checking documentation access…");
  else void loadReference();
});
