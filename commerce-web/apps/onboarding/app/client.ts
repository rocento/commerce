export class ApiError extends Error {
  constructor(
    public code: string,
    public status: number,
  ) {
    super(code);
  }
}
export async function api<T = unknown>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch("/api/control/" + path, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    headers: { "Content-Type": "application/json", "X-Rocento-Request": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok)
    throw new ApiError(result.code ?? "SERVICE_UNAVAILABLE", response.status);
  return result as T;
}
export function message(error: unknown) {
  const code = error instanceof ApiError ? error.code : "";
  return (
    (
      {
        INVALID_EMAIL: "Enter a valid email address.",
        PASSWORD_LENGTH: "Use a password of 12–128 bytes.",
        INVALID_CREDENTIALS: "The email or password is incorrect.",
        INVALID_OR_EXPIRED_LINK:
          "This link has expired or was already used. Request a new one.",
        TOO_MANY_ATTEMPTS: "Too many attempts. Please try again in 15 minutes.",
        AUTH_BUSY: "Sign-in is busy. Please try again shortly.",
        EMAIL_VERIFICATION_REQUIRED:
          "Verify your email before reserving your store address.",
        THEME_REQUIRED:
          "Choose a storefront theme before reserving your address.",
        SLUG_UNAVAILABLE: "This address is already taken. Choose another.",
        RESERVED_SLUG: "This address is reserved. Choose another.",
        INVALID_SLUG:
          "Use 3–40 lowercase letters, numbers, or internal hyphens.",
        DRAFT_CHANGED:
          "This draft changed in another tab. Reload to see the latest version.",
        RESERVATION_LOCKED:
          "The brand, address, and plan are locked after reservation.",
        RESERVATION_EXPIRED:
          "This reservation has expired. Contact support before continuing.",
        UNAUTHENTICATED: "Your session has expired. Sign in again.",
      } as Record<string, string>
    )[code] ??
    "The service is unavailable. Your changes have not been saved; please try again."
  );
}
