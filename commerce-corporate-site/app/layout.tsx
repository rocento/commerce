import type { Metadata } from "next";
import { Analytics } from "@/components/analytics";
import { Navigation } from "@/components/navigation";
import { Footer } from "@/components/sections";
import { site } from "@/lib/site";
import "./globals.css";
export const metadata: Metadata = {
  metadataBase: new URL(site.url),
  title: {
    default: "Rocento — Commerce that understands the journey",
    template: "%s | Rocento",
  },
  description: site.description,
  openGraph: {
    siteName: site.name,
    type: "website",
    title: "Rocento — Commerce that understands the journey",
    description: site.description,
  },
  robots: process.env.SITE_URL
    ? { index: true, follow: true }
    : { index: false, follow: false },
  icons: { icon: [{ url: "/brand/favicon.ico", sizes: "any" }, { url: "/brand/favicon-32.png", type: "image/png", sizes: "32x32" }], apple: "/brand/apple-touch-icon.png" },
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <Analytics />
        <script type="application/ld+json" dangerouslySetInnerHTML={{__html:JSON.stringify({"@context":"https://schema.org","@graph":[{"@type":"Organization","@id":`${site.url}#organization`,name:site.name,url:site.url},{"@type":"SoftwareApplication","@id":`${site.url}#software`,name:site.name,applicationCategory:"BusinessApplication",operatingSystem:"Web",description:site.description,url:site.url,author:{"@id":`${site.url}#organization`}}]}).replace(/</g,"\\u003c")}} />
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <Navigation />
        <main id="main">{children}</main>
        <Footer />
      </body>
    </html>
  );
}
