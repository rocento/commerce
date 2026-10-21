import { BreadcrumbJsonLd } from "@/components/discovery-page";

const example = `curl --fail-with-body \\
  'https://YOUR-STORE.example/api/v1/catalog/categories' \\
  --header 'Accept: application/json'`;

export function ApiDocumentation() {
  return <>
    <BreadcrumbJsonLd items={[{ name: "Home", path: "/" }, { name: "Docs", path: "/docs/" }, { name: "API reference", path: "/docs/api/" }]} />
    <header className="page-hero container api-hero">
      <p className="eyebrow"><span>01</span>DEVELOPER DOCUMENTATION</p>
      <h1>Build with the<br />commerce API.</h1>
      <p>Explore the storefront and customer contracts behind Rocento. Request schemas, response models and authentication requirements, together in one reference.</p>
      <div className="api-actions">
        <a className="button" href="#api-reference">Explore endpoints <span aria-hidden="true">↓</span></a>
        <a className="button secondary" href="/docs/api/openapi.json" download>Download OpenAPI JSON</a>
      </div>
      <span className="status-label">Application API preview · Read-only reference</span>
    </header>
    <div className="container api-guide">
      <aside className="api-preview-note"><strong>Plan an integration with our team.</strong> This reference documents selected existing application APIs. A generally available developer API, stability commitment and self-service API key flow have not been released. Confirm your installation’s version and approved access before integrating. Administrative and internal service contracts are outside this public reference.</aside>
      <section className="api-conventions" aria-label="Documentation access">
        <h2>Choose the reference for your work.</h2>
        <div className="api-convention-grid">
          <div><h3>Storefront and customer APIs</h3><p>The public reference below covers reviewed shopping, customer account, fulfillment, content and support operations. Each endpoint documents the credentials it requires.</p></div>
          <div><h3>Merchant administration APIs</h3><p>In your store administration, open <strong>System → API reference</strong>. Your role needs <strong>View API documentation</strong> permission. The reference loads only after the server verifies your session and current permission.</p></div>
          <div><h3>Internal services</h3><p>Assistant delegation, service operations and internal contracts remain in the private engineering reference. They are not available through public documentation or merchant documentation access.</p></div>
        </div>
      </section>
      <div className="api-guide-grid">
        <section>
          <p className="eyebrow"><span>02</span>GET STARTED</p>
          <h2>Your store is the API host.</h2>
          <p>Use the HTTPS origin of your approved Rocento installation, followed by <code>/api</code>. Endpoint paths below start with <code>/v1</code>. The corporate website at rocento.com hosts documentation; it is not a shared merchant API.</p>
          <pre tabIndex={0} aria-label="Example catalog request"><code>{example}</code></pre>
          <p className="api-caption">Replace the example hostname with your installation. This sample reads the catalog without sending credentials.</p>
        </section>
        <section>
          <p className="eyebrow"><span>03</span>AUTHENTICATION</p>
          <h2>Access follows the customer.</h2>
          <p>Catalog discovery is public where indicated. Customer endpoints use <code>Authorization: Bearer &lt;access_token&gt;</code>, issued by the customer login flow. Refresh and guest-cart sessions use cookies managed by the installation.</p>
          <p>Mutating requests require <code>X-Commerce-Request: 1</code> and must satisfy the deployment’s origin checks. Checkout additionally requires a verified customer. The backend checks ownership and permissions on every protected operation.</p>
          <p>Keep credentials out of URLs, logs and source code. Use an approved test installation for development. This page has no credential entry or request execution.</p>
        </section>
      </div>
      <section className="api-conventions">
        <h2>Request and response conventions</h2>
        <div className="api-convention-grid">
          <div><h3>JSON and identifiers</h3><p>Send JSON with <code>Content-Type: application/json</code> where a body is specified. Treat IDs as opaque strings and follow each operation’s schema for prices, currencies, pagination and required fields.</p></div>
          <div><h3>Errors and retries</h3><p>Inspect the HTTP status and documented error body. Authentication failures use 401; access restrictions use 403. For 429 or temporary 503 responses, honor <code>Retry-After</code> when present. Retry writes only according to that operation’s idempotency contract.</p></div>
          <div><h3>Store boundaries</h3><p>Each merchant has a separate database and installation. Customer tokens and administrator sessions belong to that installation. Request bodies cannot select another merchant or grant ownership. Delivery, availability and checkout totals are validated against current store data.</p></div>
        </div>
      </section>
      <section id="api-reference" className="api-reference-section">
        <div className="api-reference-heading"><div><p className="eyebrow"><span>04</span>ENDPOINT REFERENCE</p><h2>Explore the contract.</h2></div><a href="/docs/api/reference/" target="_blank" rel="noopener noreferrer">Open full reference ↗</a></div>
        <p>Filter by API group, expand an operation, and inspect its parameters and models. The viewer is powered by Swagger UI and uses the same downloadable OpenAPI document.</p>
        <iframe title="Rocento API endpoint reference" src="/docs/api/reference/" className="api-reference-frame" sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer" />
      </section>
      <p className="api-contact">Need administrative or partner integration access? <a href="mailto:info@rocento.com">Contact the Rocento team</a> to agree on scope and access.</p>
    </div>
  </>;
}
