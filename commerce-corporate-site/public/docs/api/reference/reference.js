"use strict";
// The only request this viewer is allowed to send is its own reviewed schema.
// No credentials, query-string configuration, remote validators or API execution.
const schemaUrl = new URL("../openapi.json", window.location.href).href;
const readOnlyPlugin = () => ({
  components: {
    authorizeBtn: () => null,
    authorizeOperationBtn: () => null,
  },
});
try {
  SwaggerUIBundle({
    dom_id: "#swagger-ui",
    url: schemaUrl,
    layout: "BaseLayout",
    deepLinking: true,
    filter: true,
    docExpansion: "list",
    defaultModelsExpandDepth: -1,
    displayRequestDuration: false,
    supportedSubmitMethods: [],
    tryItOutEnabled: false,
    validatorUrl: null,
    queryConfigEnabled: false,
    persistAuthorization: false,
    withCredentials: false,
    plugins: [readOnlyPlugin],
    requestInterceptor(request) {
      if (new URL(request.url, window.location.href).href !== schemaUrl || (request.method || "GET").toUpperCase() !== "GET") {
        throw new Error("This reference does not execute API requests.");
      }
      request.credentials = "omit";
      request.headers = { Accept: "application/json" };
      return request;
    },
    onComplete() { document.getElementById("reference-status").hidden = true; },
  });
} catch {
  document.getElementById("reference-status").textContent = "The reference could not load. Use the OpenAPI download above.";
}
