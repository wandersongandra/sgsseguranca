jest.mock("next/server", () => ({
  NextResponse: {
    redirect: (url: URL) => ({
      kind: "redirect",
      url: url.toString(),
    }),
    next: (init?: unknown) => ({
      kind: "next",
      init,
      headers: {
        set: jest.fn(),
      },
    }),
  },
}));

jest.mock("@/lib/route-config", () => ({
  isHiddenRoute: jest.fn(() => false),
}));

import { proxy, buildCsp } from "./proxy";

type ProxyResult = ReturnType<typeof proxy> & {
  kind?: "redirect" | "next";
  url?: string;
};

function makeRequest(pathname: string, cookieNames: string[] = []) {
  const url = `https://app.sgsseguranca.com.br${pathname}`;
  return {
    nextUrl: new URL(url),
    url,
    cookies: {
      has: (name: string) => cookieNames.includes(name),
    },
    headers: new Headers(),
  } as unknown as Parameters<typeof proxy>[0];
}

describe("buildCsp", () => {
  it("mantem unsafe-inline em style-src-elem no CSP de producao", () => {
    const csp = buildCsp("abc123", { isProduction: true });
    expect(csp).toContain("style-src-elem 'self' 'unsafe-inline'");
  });

  it("nao inclui nonce em style-src-elem para nao bloquear bibliotecas de UI", () => {
    const csp = buildCsp("abc123", { isProduction: true });
    expect(csp).not.toContain("style-src-elem 'self' 'nonce-abc123'");
  });

  it("inclui nonce apenas em script-src", () => {
    const csp = buildCsp("abc123", { isProduction: false });
    expect(csp).toContain("'nonce-abc123'");
    const scriptSrcMatch = csp.match(/script-src ([^;]+)/);
    expect(scriptSrcMatch?.[1]).toContain("'nonce-abc123'");
  });
});

describe("proxy auth routing", () => {
  it("redireciona dashboard sem refresh_csrf para /login sem redirect param", () => {
    const response = proxy(makeRequest("/dashboard")) as ProxyResult;

    expect(response.kind).toBe("redirect");
    expect(response.url).toBe("https://app.sgsseguranca.com.br/login");
  });

  it("não bloqueia a página de login quando refresh_csrf está stale", () => {
    const response = proxy(makeRequest("/login", ["refresh_csrf"])) as ProxyResult;

    expect(response.kind).toBe("next");
  });

  it("permite dashboard seguir para o bootstrap client-side quando refresh_csrf existe", () => {
    const response = proxy(
      makeRequest("/dashboard", ["refresh_csrf"]),
    ) as ProxyResult;

    expect(response.kind).toBe("next");
  });
});
