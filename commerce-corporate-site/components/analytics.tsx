"use client";

import Script from "next/script";
import { usePathname } from "next/navigation";

export function Analytics() {
  const pathname = usePathname();
  // Keep developer reference visits free of third-party scripts and telemetry.
  if (pathname === "/docs/api" || pathname?.startsWith("/docs/api/")) return null;
  return <>
    <Script src="https://www.googletagmanager.com/gtag/js?id=G-S1CR4WFWJ4" strategy="lazyOnload" />
    <Script id="google-analytics" strategy="lazyOnload">{`
      window.dataLayer = window.dataLayer || [];
      function gtag(){dataLayer.push(arguments);}
      gtag('js', new Date());
      gtag('config', 'G-S1CR4WFWJ4');
    `}</Script>
  </>;
}
