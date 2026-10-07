import type { ReactNode } from "react";
import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./globals.css";
import { DevCacheReset } from "@/components/DevCacheReset";

/**
 * Inline script para reset de cache em desenvolvimento.
 * SECURITY: Script hardcoded sem interpolação - seguro contra XSS.
 * Apenas em desenvolvimento, com verificação de hostname.
 */
const DEV_CACHE_RESET_INLINE_SCRIPT = `
(() => {
  try {
    const isLocalHost =
      window.location.hostname === 'localhost' ||
      window.location.hostname === '127.0.0.1' ||
      window.location.hostname.endsWith('.local');

    if (${process.env.NODE_ENV === "production"} || !isLocalHost) {
      return;
    }

    const sessionKey = 'sgs.dev-inline-cache-reset.v2';
    if (window.sessionStorage.getItem(sessionKey) === 'done') {
      return;
    }

    const reset = async () => {
      const registrations =
        'serviceWorker' in navigator
          ? await navigator.serviceWorker.getRegistrations().catch(() => [])
          : [];

      await Promise.all(
        registrations.map((registration) =>
          registration.unregister().catch(() => false),
        ),
      );

      if ('caches' in window) {
        const keys = await window.caches.keys().catch(() => []);
        const targets = keys.filter(
          (key) => key.startsWith('sgs-shell') || key.startsWith('gst-shell'),
        );
        await Promise.all(targets.map((key) => window.caches.delete(key)));
      }

      window.sessionStorage.setItem(sessionKey, 'done');

      if (registrations.length > 0) {
        window.location.reload();
      }
    };

    void reset();
  } catch (_) {
    // no-op
  }
})();
`;

export const metadata: Metadata = {
  title: "SGS | Sistema de Gestão de Segurança",
  description: "Sistema inteligente de gestão de Segurança e Saúde no Trabalho",
  applicationName: "SGS – Sistema de Gestão de Segurança",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "SGS",
    statusBarStyle: "default",
    startupImage: "/icon-512.svg",
  },
  icons: {
    icon: [
      { url: "/icon-192.svg", type: "image/svg+xml", sizes: "192x192" },
      { url: "/icon-512.svg", type: "image/svg+xml", sizes: "512x512" },
    ],
    apple: [
      { url: "/icon-192.svg", type: "image/svg+xml", sizes: "192x192" },
    ],
    other: [
      { rel: "mask-icon", url: "/icon-maskable.svg", color: "#1D5B8D" },
    ],
  },
};

export const viewport: Viewport = {
  themeColor: "#1D5B8D",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  const headersList = await headers();
  const nonce = headersList.get("x-nonce") ?? "";

  return (
    <html lang="pt-BR">
      <body
        className="antialiased"
        {...(nonce ? { "data-nonce": nonce } : {})}
      >
        <script
          nonce={nonce || undefined}
          dangerouslySetInnerHTML={{ __html: DEV_CACHE_RESET_INLINE_SCRIPT }}
        />
        {process.env.NODE_ENV !== "production" && <DevCacheReset />}
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[200] focus:rounded-lg focus:bg-[var(--ds-color-surface-base)] focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-[var(--ds-color-text-primary)] focus:shadow-[var(--ds-shadow-md)] focus:outline-none focus:ring-2 focus:ring-[var(--ds-color-focus)]"
        >
          Ir para o conteúdo principal
        </a>
        {children}
      </body>
    </html>
  );
}
