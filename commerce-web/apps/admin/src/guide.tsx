import { useEffect } from 'react';
import { PageHeader } from './page-header';

const documentationUrl = 'https://rocento.com/docs/fulfillment/';
const documentationSections = new Set(['#guide-flow', '#guide-modules', '#guide-setup', '#guide-help']);

export function Guide({ permissions }: { permissions: string[] }) {
  // Keep the existing route contract; public documentation is available to every role.
  void permissions;
  const hash = typeof window === 'undefined' ? '' : window.location.hash;
  const destination = documentationUrl + (documentationSections.has(hash) ? hash : '');

  useEffect(() => {
    window.location.replace(destination);
  }, [destination]);

  return <main className="catalog-admin">
    <PageHeader title="Guide has moved" description="Find the fulfillment guide and platform documentation in Rocento Documentation." />
    <p role="status">Opening the public fulfillment guide…</p>
    <p><a className="primary-link" href={destination}>Continue to Rocento Documentation</a></p>
  </main>;
}
