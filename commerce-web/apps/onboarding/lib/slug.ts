const reservedSlugs = new Set([
  "admin",
  "clients",
  "onboarding",
  "api",
  "www",
  "billing",
  "support",
  "ingress",
  "mail",
  "static",
  "assets",
  "security",
  "status",
  "docs",
  "cdn",
  "auth",
]);

export function normalizeSlug(value: string): string {
  const slug = value.trim().toLowerCase().replace(/\s+/g, "-");
  if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(slug))
    throw new Error("INVALID_SLUG");
  if (reservedSlugs.has(slug) || slug.endsWith("-admin"))
    throw new Error("RESERVED_SLUG");
  return slug;
}

export function hostnames(slug: string) {
  const normalized = normalizeSlug(slug);
  return {
    storefront: `${normalized}.rocento.com`,
    admin: `${normalized}-admin.rocento.com`,
  };
}
