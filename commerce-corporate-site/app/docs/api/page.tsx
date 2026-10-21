import type { Metadata } from "next";
import { ApiDocumentation } from "@/components/api-documentation";

export const metadata: Metadata = {
  title: "API reference",
  description: "Explore Rocento storefront and customer API endpoints, authentication, request schemas and response models.",
  alternates: { canonical: "/docs/api/" },
  openGraph: {
    title: "Rocento API reference",
    description: "The read-only storefront and customer API reference, powered by OpenAPI and Swagger UI.",
  },
};

export default function ApiReferencePage() {
  return <ApiDocumentation />;
}
