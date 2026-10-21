import { PageHeader } from './page-header';
import './api-reference.css';

export function ApiReference() {
  return <main className="merchant-api-reference">
    <PageHeader title="API reference" />
    <section className="form-card">
      <h2>Develop for your store</h2>
      <p>Browse the storefront and merchant API contract for this installation. This application API is a preview; agree integration access and compatibility with Rocento before building a production integration.</p>
      <p>This reference is read-only. Documentation access does not grant permission to call the APIs. Your store’s authentication, role permissions and customer ownership checks still apply.</p>
      <div className="merchant-api-links">
        <a href="/api-reference/" target="_blank" rel="noopener noreferrer">Open full reference ↗</a>
        <a href="/api/v1/admin/api-reference/openapi.json" download="rocento-merchant-openapi.json">Download OpenAPI JSON</a>
        <a href="https://rocento.com/docs/api/" target="_blank" rel="noopener noreferrer">Public storefront reference ↗</a>
      </div>
    </section>
    <iframe title="Merchant API endpoint reference" src="/api-reference/" sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer" />
  </main>;
}
