import { NextResponse } from 'next/server';
import { normalizePublicApiBaseUrl } from '@/lib/public-api-url';

// Rate limit simples em memória: máximo 10 chamadas por IP por minuto.
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_MAX = 10;
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

const DEFAULT_KEEPALIVE_TARGET = 'https://api.sgsseguranca.com.br';

function resolveKeepaliveTarget(): string {
  const raw = normalizePublicApiBaseUrl(
    process.env.BACKEND_KEEPALIVE_URL ||
      process.env.NEXT_PUBLIC_API_URL ||
      DEFAULT_KEEPALIVE_TARGET,
  );

  return raw || DEFAULT_KEEPALIVE_TARGET;
}

/**
 * Verifica autorização do caller.
 *
 * Regras:
 * - Em produção, CRON_SECRET DEVE estar definido. Se ausente → erro de configuração (500).
 * - Se CRON_SECRET está definido, o header Authorization: Bearer <secret> é obrigatório.
 * - Em desenvolvimento, sem CRON_SECRET, a rota é liberada apenas localmente.
 *
 * Retorna:
 *   { authorized: true }                    → prosseguir
 *   { authorized: false, status: 401 }      → token ausente/inválido
 *   { authorized: false, status: 500 }      → secret não configurado em produção
 */
function checkAuthorization(request: Request):
  | { authorized: true }
  | { authorized: false; status: 401 | 500 } {
  const secret = process.env.CRON_SECRET?.trim();

  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      // Configuração obrigatória ausente em produção: falha segura
      return { authorized: false, status: 500 };
    }
    // Desenvolvimento sem secret: libera (sem expor detalhes)
    return { authorized: true };
  }

  const header = request.headers.get('authorization');
  if (header !== `Bearer ${secret}`) {
    return { authorized: false, status: 401 };
  }

  return { authorized: true };
}

export async function GET(request: Request) {
  const ip =
    (request as Request & { headers: Headers }).headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown';

  if (!checkRateLimit(ip)) {
    return NextResponse.json({ ok: false, error: 'too_many_requests' }, { status: 429 });
  }

  const auth = checkAuthorization(request);

  if (!auth.authorized) {
    if (auth.status === 500) {
      // Não expõe detalhes de configuração interna
      return NextResponse.json(
        { ok: false, error: 'service_unavailable' },
        { status: 500 },
      );
    }
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const target = resolveKeepaliveTarget();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);

  try {
    const startedAt = Date.now();
    const health = await fetch(`${target}/health/ready?keepalive=1&t=${startedAt}`, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
    });

    const elapsedMs = Date.now() - startedAt;
    return NextResponse.json(
      {
        ok: health.ok,
        status: health.status,
        elapsedMs,
      },
      { status: health.ok ? 200 : 503 },
    );
  } catch {
    // Não expõe mensagem de erro interna ao caller externo
    return NextResponse.json(
      { ok: false, status: 503 },
      { status: 503 },
    );
  } finally {
    clearTimeout(timeout);
  }
}
