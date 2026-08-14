import { NextRequest, NextResponse } from "next/server";
import { isHiddenRoute } from "@/lib/route-config";

const isProduction = process.env.NODE_ENV === "production";

// Cookie definido pelo backend com path '/' — presente enquanto sessao está ativa.
const REFRESH_CSRF_COOKIE = "refresh_csrf";

const PUBLIC_ROUTE_PREFIXES = [
  "/login",
  "/forgot-password",
  "/reset-password",
  "/assinar",
  "/_next",
  "/favicon.ico",
  "/monitoring-tunnel",
  "/api",
];

function isDashboardRoute(pathname: string): boolean {
  return pathname === "/dashboard" || pathname.startsWith("/dashboard/");
}

function isProxyRoute(pathname: string): boolean {
  return pathname === "/proxy" || pathname.startsWith("/proxy/");
}

function isDevtoolsRoute(pathname: string): boolean {
  return pathname === "/devtools" || pathname.startsWith("/devtools/");
}

function isPublicRoute(pathname: string): boolean {
  return PUBLIC_ROUTE_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export function buildCsp(
  nonce: string,
  options?: { isProduction?: boolean },
): string {
  const production = options?.isProduction ?? isProduction;
  const apiOrigin = process.env.NEXT_PUBLIC_API_URL?.trim();
  const apiWsOrigin = apiOrigin?.replace(/^https?:\/\//, (match) => {
    const isHttps = match === "https://";
    const scheme = isHttps ? "wss" : "ws";
    return `${scheme}://`;
  });
  const connectSrc = [
    "'self'",
    apiOrigin,
    apiWsOrigin,
    !production ? "http://localhost:3011" : null,
    !production ? `${"ws"}://${"localhost"}:3000` : null,
    !production ? `${"ws"}://${"localhost"}:3011` : null,
    "https://*.sentry.io",
    "https://challenges.cloudflare.com",
    "https://*.r2.cloudflarestorage.com",
    "https://*.backblazeb2.com",
    "https://api.elevenlabs.io",
    "wss://api.elevenlabs.io",
  ].filter(Boolean);

  const scriptSrc = [
    "'self'",
    `'nonce-${nonce}'`,
    "'strict-dynamic'",
    !production ? "'unsafe-eval'" : null,
    "https://challenges.cloudflare.com",
  ].filter(Boolean);

  const directives = [
    `default-src 'self'`,
    `base-uri 'self'`,
    `object-src 'none'`,
    `frame-ancestors 'none'`,
    `img-src 'self' data: blob: https://*.r2.cloudflarestorage.com https://*.backblazeb2.com`,
    `font-src 'self' data:`,
    `style-src 'self' 'unsafe-inline'`,
    // style-src-elem: bibliotecas de UI (recharts, sonner, Radix) injetam tags
    // <style> em runtime SEM nonce. Pela spec CSP3, quando um nonce está presente
    // nesta diretiva o navegador IGNORA 'unsafe-inline' — logo, manter o nonce
    // bloqueava esses estilos em produção (gráficos, toasts e dropdowns quebrados,
    // e mensagens de erro invisíveis). Usamos 'unsafe-inline' sem nonce: injeção de
    // CSS é de baixa severidade e o script-src continua travado por nonce +
    // strict-dynamic, que é onde está o risco real de XSS.
    `style-src-elem 'self' 'unsafe-inline'`,
    // style-src-attr: React usa style={} => atributo style HTML; mantido como unsafe-inline
    // pois nonce não é suportado em atributos style pela spec CSP3.
    `style-src-attr 'unsafe-inline'`,
    `script-src ${scriptSrc.join(" ")}`,
    `connect-src ${connectSrc.join(" ")}`,
    `frame-src 'self' https://challenges.cloudflare.com`,
    `media-src 'self' blob: data: ${[apiOrigin, "https://*.r2.cloudflarestorage.com", "https://*.backblazeb2.com", "https://api.elevenlabs.io"].filter(Boolean).join(" ")}`,
    `worker-src 'self' blob:`,
    `form-action 'self'`,
    "upgrade-insecure-requests",
  ];

  return directives.join("; ");
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isPublicRoute(pathname)) {
    const random = crypto.getRandomValues(new Uint8Array(16));
    const nonce = btoa(String.fromCharCode(...random));
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set("x-nonce", nonce);

    const response = NextResponse.next({
      request: {
        headers: requestHeaders,
      },
    });

    response.headers.set("Content-Security-Policy", buildCsp(nonce));
    response.headers.set("X-Frame-Options", "DENY");
    response.headers.set("X-Content-Type-Options", "nosniff");
    response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
    response.headers.set(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    );
    return response;
  }

  if (isHiddenRoute(pathname)) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  if (isProduction && isDevtoolsRoute(pathname)) {
    return new NextResponse("Not Found", { status: 404 });
  }

  // /proxy/auth/csrf e /proxy/auth/login devem ser acessíveis sem sessão —
  // são necessários para o fluxo de login de usuários novos ou sem cookie.
  const isAuthProxyPath =
    pathname === "/proxy/auth/csrf" || pathname === "/proxy/auth/login";

  if (
    (isDashboardRoute(pathname) ||
      (isProxyRoute(pathname) && !isAuthProxyPath)) &&
    !request.cookies.has(REFRESH_CSRF_COOKIE)
  ) {
    const loginUrl = new URL("/login", request.url);
    return NextResponse.redirect(loginUrl);
  }

  const random = crypto.getRandomValues(new Uint8Array(16));
  const nonce = btoa(String.fromCharCode(...random));
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);

  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });

  response.headers.set("Content-Security-Policy", buildCsp(nonce));
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  );
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
