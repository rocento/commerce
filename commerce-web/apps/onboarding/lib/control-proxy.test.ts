import { expect, test } from "vitest";
import { controlProxy } from "./control-proxy";

const envKeys = ["NODE_ENV", "CUSTOMER_ORIGIN", "CONTROL_API_URL"];
function setEnv(values: Record<string, string>) {
  const previous = Object.fromEntries(
    envKeys.map((key) => [key, process.env[key]]),
  );
  for (const key of envKeys) delete process.env[key];
  Object.assign(process.env, values);
  return () => {
    for (const key of envKeys) delete process.env[key];
    for (const [key, value] of Object.entries(previous))
      if (value !== undefined) process.env[key] = value;
  };
}

test("proxy rejects cross-origin and unmarked state changes before forwarding", async () => {
  const restoreEnv = setEnv({
    NODE_ENV: "development",
    CUSTOMER_ORIGIN: "http://127.0.0.1:3100",
    CONTROL_API_URL: "http://127.0.0.1:4100",
  });
  const originalFetch = globalThis.fetch;
  let forwarded = 0;
  globalThis.fetch = (async () => {
    forwarded++;
    return Response.json({ status: "OK" });
  }) as typeof fetch;
  try {
    const cases: Record<string, string>[] = [
      {
        origin: "https://attacker.example",
        "x-rocento-request": "1",
        "content-type": "application/json",
      },
      {
        origin: "http://127.0.0.1:3100",
        "content-type": "application/json",
      },
    ];
    for (const headers of cases) {
      const response = await controlProxy(
        new Request("http://127.0.0.1:3100/api/control/customer/auth/logout", {
          method: "POST",
          headers,
          body: "{}",
        }),
        ["customer", "auth", "logout"],
      );
      expect(response.status).toBe(403);
      expect((await response.json()).code).toBe("FORBIDDEN");
    }
    expect(forwarded).toBe(0);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
  }
});

test("proxy keeps production customer sessions in secure host-only cookies", async () => {
  const restoreEnv = setEnv({
    NODE_ENV: "production",
    CUSTOMER_ORIGIN: "https://onboard.example.com",
    CONTROL_API_URL: "https://control.example.com",
  });
  const originalFetch = globalThis.fetch;
  const token = "a".repeat(64);
  const forwarded: Array<{ url: string; authorization?: string }> = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    forwarded.push({
      url,
      authorization: headers.get("authorization") ?? undefined,
    });
    if (url.endsWith("/customer/auth/login"))
      return Response.json({
        sessionToken: token,
        user: { email: "owner@example.com" },
      });
    if (url.endsWith("/customer/auth/logout"))
      return Response.json({ status: "OK" });
    return Response.json({ email: "owner@example.com" });
  }) as typeof fetch;
  try {
    const login = await controlProxy(
      new Request(
        "https://onboard.example.com/api/control/customer/auth/login",
        {
          method: "POST",
          headers: {
            origin: "https://onboard.example.com",
            "x-rocento-request": "1",
            "content-type": "application/json",
          },
          body: JSON.stringify({ identifier: "owner@example.com" }),
        },
      ),
      ["customer", "auth", "login"],
    );
    const loginCookie = login.headers.get("set-cookie") ?? "";
    expect(login.status).toBe(200);
    expect(loginCookie).toMatch(/^__Host-rocento_customer=/);
    expect(loginCookie).toMatch(/HttpOnly/);
    expect(loginCookie).toMatch(/Secure/);
    expect(loginCookie).toMatch(/SameSite=Strict/);
    expect(loginCookie).toMatch(/Path=\//);
    expect(loginCookie).not.toMatch(/Domain=/i);
    expect((await login.json()).sessionToken).toBeUndefined();
    expect(login.headers.get("cache-control")).toBe("no-store");
    expect(login.headers.get("referrer-policy")).toBe("no-referrer");
    expect(login.headers.get("x-content-type-options")).toBe("nosniff");

    const me = await controlProxy(
      new Request("https://onboard.example.com/api/control/me", {
        headers: { cookie: `__Host-rocento_customer=${token}` },
      }),
      ["me"],
    );
    expect(me.status).toBe(200);
    expect(forwarded[1].authorization).toBe(`Bearer ${token}`);

    const logout = await controlProxy(
      new Request(
        "https://onboard.example.com/api/control/customer/auth/logout",
        {
          method: "POST",
          headers: {
            origin: "https://onboard.example.com",
            "x-rocento-request": "1",
            "content-type": "application/json",
            cookie: `__Host-rocento_customer=${token}`,
          },
          body: "{}",
        },
      ),
      ["customer", "auth", "logout"],
    );
    expect(logout.headers.get("set-cookie") ?? "").toMatch(/Max-Age=0/);
    expect(logout.headers.get("set-cookie") ?? "").not.toMatch(/Domain=/i);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
  }
});
