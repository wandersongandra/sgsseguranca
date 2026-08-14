import { NextResponse } from "next/server";

export const runtime = "nodejs";

// Rate limit simples em memória: máximo 60 envelopes por IP por minuto.
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_MAX = 60;
const RATE_LIMIT_WINDOW_MS = 60_000;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX) return false;
  entry.count++;
  return true;
}

function getClientIp(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

function resolveTunnelTarget(): string | null {
  const dsn =
    process.env.SENTRY_DSN?.trim() ??
    process.env.NEXT_PUBLIC_SENTRY_DSN?.trim();

  if (!dsn) {
    return null;
  }

  try {
    const parsed = new URL(dsn);
    const publicKey = parsed.username.trim();
    const projectId = parsed.pathname.replace(/^\//, "").trim();

    if (!publicKey || !projectId) {
      return null;
    }

    return `${parsed.origin}/api/${projectId}/envelope/?sentry_key=${encodeURIComponent(publicKey)}&sentry_version=7`;
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  if (!checkRateLimit(getClientIp(request))) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429 },
    );
  }

  const target = resolveTunnelTarget();
  if (!target) {
    return NextResponse.json(
      { error: "Sentry tunnel not configured" },
      { status: 503 },
    );
  }

  const body = await request.arrayBuffer();
  const headers = new Headers();
  const contentType = request.headers.get("content-type");
  const contentEncoding = request.headers.get("content-encoding");

  if (contentType) {
    headers.set("content-type", contentType);
  }

  if (contentEncoding) {
    headers.set("content-encoding", contentEncoding);
  }

  const sentryResponse = await fetch(target, {
    method: "POST",
    headers,
    body,
  });

  return new NextResponse(sentryResponse.body, {
    status: sentryResponse.status,
    headers: sentryResponse.headers,
  });
}

