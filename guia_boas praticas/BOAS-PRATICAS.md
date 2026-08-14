Boas Práticas de Frontend — SGS

1. Objetivo

Este guia define padrões de arquitetura, segurança, qualidade, desempenho, acessibilidade e experiência do usuário para o frontend do SGS.

O documento considera uma aplicação construída com:

Next.js App Router;

React;

TypeScript em modo estrito;

backend separado;

autenticação baseada em sessão segura;

ambiente multiempresa;

dados pessoais e ocupacionais protegidos pela LGPD.

O frontend não deve ser tratado como uma barreira de segurança. Toda autenticação, autorização, validação de tenant e verificação de permissões deve ser repetida no backend.

1. Princípios obrigatórios

O frontend do SGS deve seguir estes princípios:

utilizar Server Components por padrão;

adicionar "use client" somente quando houver estado, eventos ou APIs do navegador;

não armazenar access token ou refresh token em localStorage;

não confiar em dados decodificados de JWT no navegador;

validar autenticação e autorização no servidor;

centralizar comunicação HTTP e tratamento de erros;

impedir envio duplicado de formulários;

possuir estados de carregamento, vazio, sucesso e erro;

não expor detalhes internos da API ao usuário;

manter acessibilidade por teclado e leitores de tela;

evitar otimizações sem medição;

nunca colocar secrets em variáveis NEXT_PUBLIC_*;

respeitar isolamento multiempresa em todas as operações;

registrar erros sem incluir dados pessoais ou sensíveis.

1. Autenticação e sessão

3.1 Estratégia recomendada

Para o SGS, a estratégia preferencial é:

o backend autentica o usuário;

o backend cria cookies seguros;

o navegador envia os cookies automaticamente;

o frontend usa credentials: "include" ou withCredentials: true;

o backend valida sessão, tenant, função e permissão em cada operação;

operações de escrita utilizam proteção CSRF quando aplicável.

Cookies de autenticação devem ser configurados pelo servidor com:

HttpOnly
Secure
SameSite
Path
Max-Age ou Expires

Não utilize:

localStorage.setItem('token', token);
sessionStorage.setItem('refreshToken', refreshToken);

O JavaScript da página não deve conseguir ler o refresh token.

3.2 O frontend não valida autorização

Ocultar um botão não impede uma operação.

Este código melhora a experiência, mas não protege o sistema:

{user.role === 'ADMIN' ? <DeleteCompanyButton /> : null}

O backend ainda deve validar:

identidade do usuário;

empresa ativa;

associação entre usuário e empresa;

função;

permissão específica;

situação da conta;

autenticação multifator quando exigida;

escopo do recurso solicitado.

3.3 Verificação de sessão no servidor

Centralize a leitura da sessão em uma camada de acesso a dados.

// src/lib/auth/verify-session.ts
import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

export interface SessionUser {
  id: string;
  companyId: string;
  role: string;
}

export async function verifySession(): Promise<SessionUser> {
  const cookieStore = await cookies();
  const hasSession = cookieStore.has('refresh_token');

  if (!hasSession) {
    redirect('/login');
  }

  const response = await fetch(`${process.env.INTERNAL_API_URL}/auth/session`, {
    method: 'GET',
    headers: {
      cookie: cookieStore.toString(),
    },
    cache: 'no-store',
  });

  if (!response.ok) {
    redirect('/login');
  }

  return response.json() as Promise<SessionUser>;
}

Uso em uma página protegida:

// src/app/(protected)/dashboard/page.tsx
import { verifySession } from '@/lib/auth/verify-session';

export default async function DashboardPage() {
  const user = await verifySession();

  return (
    <main>
      <h1>Dashboard</h1>
      <p>Usuário autenticado: {user.id}</p>
    </main>
  );
}

A presença de um cookie não comprova uma sessão válida. A validação definitiva deve ocorrer no backend.

3.4 Proxy para redirecionamento otimista

O Proxy do Next.js pode evitar que usuários sem cookie acessem inicialmente áreas protegidas.

// src/proxy.ts
import { NextRequest, NextResponse } from 'next/server';

const protectedPrefixes = ['/dashboard', '/empresas', '/usuarios', '/relatorios'];
const publicAuthRoutes = ['/login', '/recuperar-senha'];

export function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const hasSessionCookie = request.cookies.has('refresh_token');

  const isProtected = protectedPrefixes.some((prefix) =>
    pathname.startsWith(prefix),
  );

  if (isProtected && !hasSessionCookie) {
    return NextResponse.redirect(new URL('/login', request.url));
  }

  if (publicAuthRoutes.includes(pathname) && hasSessionCookie) {
    return NextResponse.redirect(new URL('/dashboard', request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
};

Esse redirecionamento é apenas uma verificação otimista. Não substitui a validação no servidor ou no backend.

1. Cliente HTTP centralizado

4.1 Instância da API

// src/lib/http/api-client.ts
import axios from 'axios';

export const apiClient = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL,
  timeout: 15_000,
  withCredentials: true,
  headers: {
    Accept: 'application/json',
  },
});

A URL pública da API pode ser exposta. Secrets, credenciais e chaves privadas não podem utilizar o prefixo NEXT_PUBLIC_.

4.2 Proteção CSRF

Quando o backend adotar token CSRF, envie-o somente nas operações que alteram estado.

// src/lib/http/csrf.ts
const unsafeMethods = new Set(['post', 'put', 'patch', 'delete']);

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') {
    return null;
  }

  const prefix = `${encodeURIComponent(name)}=`;
  const item = document.cookie
    .split('; ')
    .find((cookie) => cookie.startsWith(prefix));

  return item ? decodeURIComponent(item.slice(prefix.length)) : null;
}

export function configureCsrfInterceptor(): void {
  apiClient.interceptors.request.use((config) => {
    const method = config.method?.toLowerCase();

    if (method && unsafeMethods.has(method)) {
      const csrfToken = readCookie('csrf-token');

      if (csrfToken) {
        config.headers.set('X-CSRF-Token', csrfToken);
      }
    }

    return config;
  });
}

O cookie de CSRF pode ser legível pelo JavaScript quando o padrão utilizado for double-submit cookie. O cookie de sessão deve permanecer HttpOnly.

4.3 Renovação de sessão com uma única tentativa

Evite disparar várias renovações simultâneas.

// src/lib/http/session-refresh.ts
import type { AxiosError, InternalAxiosRequestConfig } from 'axios';
import { apiClient } from './api-client';

interface RetryableRequest extends InternalAxiosRequestConfig {
  _retried?: boolean;
}

let refreshPromise: Promise<void> | null = null;

async function refreshSession(): Promise<void> {
  await apiClient.post('/auth/refresh', undefined, {
    headers: {
      'X-Skip-Auth-Refresh': 'true',
    },
  });
}

apiClient.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const request = error.config as RetryableRequest | undefined;
    const status = error.response?.status;

    if (
      !request ||
      status !== 401 ||
      request._retried ||
      request.headers?.['X-Skip-Auth-Refresh'] === 'true'
    ) {
      return Promise.reject(error);
    }

    request._retried = true;

    refreshPromise ??= refreshSession().finally(() => {
      refreshPromise = null;
    });

    try {
      await refreshPromise;
      return apiClient.request(request);
    } catch {
      if (typeof window !== 'undefined') {
        const returnTo = encodeURIComponent(
          `${window.location.pathname}${window.location.search}`,
        );

        window.location.assign(`/login?returnTo=${returnTo}`);
      }

      return Promise.reject(error);
    }
  },
);

A implementação deve ser adaptada aos endpoints e cabeçalhos reais do backend.

Não crie loops infinitos de refresh.

1. Tratamento padronizado de erros

5.1 Estrutura de erro da aplicação

// src/lib/errors/app-error.ts
export type AppErrorKind =
  | 'validation'
  | 'authentication'
  | 'authorization'
  | 'not_found'
  | 'conflict'
  | 'rate_limit'
  | 'network'
  | 'server'
  | 'unknown';

export interface AppError {
  kind: AppErrorKind;
  message: string;
  status?: number;
  requestId?: string;
  fieldErrors?: Record<string, string[]>;
}

5.2 Normalização de erros HTTP

// src/lib/errors/normalize-api-error.ts
import axios from 'axios';
import type { AppError, AppErrorKind } from './app-error';

interface ApiErrorPayload {
  message?: string;
  requestId?: string;
  errors?: Record<string, string[]>;
}

function statusToKind(status?: number): AppErrorKind {
  switch (status) {
    case 400:
    case 422:
      return 'validation';
    case 401:
      return 'authentication';
    case 403:
      return 'authorization';
    case 404:
      return 'not_found';
    case 409:
      return 'conflict';
    case 429:
      return 'rate_limit';
    default:
      return status && status >= 500 ? 'server' : 'unknown';
  }
}

export function normalizeApiError(error: unknown): AppError {
  if (!axios.isAxiosError<ApiErrorPayload>(error)) {
    return {
      kind: 'unknown',
      message: 'Ocorreu um erro inesperado.',
    };
  }

  if (!error.response) {
    return {
      kind: 'network',
      message: 'Não foi possível conectar ao servidor.',
    };
  }

  const status = error.response.status;
  const payload = error.response.data;

  return {
    kind: statusToKind(status),
    status,
    message: payload?.message || 'Não foi possível concluir a operação.',
    requestId: payload?.requestId,
    fieldErrors: payload?.errors,
  };
}

Não apresente ao usuário:

stack trace;

query SQL;

nome de tabela;

caminho interno do servidor;

token;

segredo;

conteúdo sensível retornado por exceção.

Quando disponível, mostre apenas o identificador da ocorrência:

<p>
  Não foi possível concluir a operação.
  {error.requestId ? ` Código: ${error.requestId}` : null}
</p>

5.3 Função segura para requisições

// src/lib/http/request.ts
import type { AxiosRequestConfig } from 'axios';
import { apiClient } from './api-client';
import { normalizeApiError } from '@/lib/errors/normalize-api-error';

export async function request<T>(
  config: AxiosRequestConfig,
): Promise<T> {
  try {
    const response = await apiClient.request<T>(config);
    return response.data;
  } catch (error) {
    throw normalizeApiError(error);
  }
}

Uso:

interface Company {
  id: string;
  name: string;
}

export function getCompanies(signal?: AbortSignal): Promise<Company[]> {
  return request<Company[]>({
    method: 'GET',
    url: '/companies',
    signal,
  });
}

1. Cancelamento de requisições

Requisições antigas devem ser canceladas quando o componente for desmontado ou quando uma busca for substituída.

'use client';

import { useEffect, useState } from 'react';
import { getCompanies } from '@/features/companies/api/get-companies';

export function CompanyList() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    getCompanies(controller.signal)
      .then(setCompanies)
      .catch((requestError: unknown) => {
        if (!controller.signal.aborted) {
          setError(
            requestError instanceof Error
              ? requestError.message
              : 'Não foi possível carregar as empresas.',
          );
        }
      });

    return () => controller.abort();
  }, []);

  if (error) {
    return <p role="alert">{error}</p>;
  }

  return <CompanyTable companies={companies} />;
}

1. Estados de interface

Toda tela que depende de dados deve considerar:

carregando;

sucesso;

vazio;

erro recuperável;

erro sem recuperação;

acesso negado;

sessão expirada;

operação parcial;

modo offline, quando aplicável.

7.1 Arquivo loading.tsx

// src/app/(protected)/empresas/loading.tsx
export default function CompaniesLoading() {
  return (
    <section aria-busy="true" aria-live="polite">
      <span className="sr-only">Carregando empresas</span>
      <CompanyTableSkeleton />
    </section>
  );
}

7.2 Arquivo error.tsx

// src/app/(protected)/empresas/error.tsx
'use client';

interface ErrorPageProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function CompaniesError({
  error,
  reset,
}: ErrorPageProps) {
  return (
    <section role="alert">
      <h2>Não foi possível carregar as empresas</h2>
      <p>Tente novamente. Caso o problema continue, informe o código abaixo.</p>

      {error.digest ? <code>{error.digest}</code> : null}

      <button type="button" onClick={reset}>
        Tentar novamente
      </button>
    </section>
  );
}

7.3 Estado vazio

interface EmptyStateProps {
  title: string;
  description: string;
  action?: React.ReactNode;
}

export function EmptyState({
  title,
  description,
  action,
}: EmptyStateProps) {
  return (
    <section>
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </section>
  );
}

Não confunda uma lista vazia com erro de carregamento.

1. Error Boundaries

Error Boundaries capturam erros de renderização em componentes descendentes. Eles não substituem o tratamento de falhas em eventos ou requisições assíncronas.

No App Router, prefira error.tsx por segmento. Utilize uma Error Boundary manual somente em widgets clientes que precisem falhar de forma isolada.

'use client';

import {
  Component,
  type ErrorInfo,
  type ReactNode,
} from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = {
    hasError: false,
  };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return {
      hasError: true,
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError?.(error, info);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        this.props.fallback ?? (
          <div role="alert">
            Não foi possível exibir este conteúdo.
          </div>
        )
      );
    }

    return this.props.children;
  }
}

1. Formulários e validação

9.1 Princípios

Todo formulário deve:

possuir rótulo visível;

associar erro ao campo;

validar no cliente para experiência;

validar novamente no backend para segurança;

impedir múltiplos envios;

preservar os valores após erro recuperável;

não revelar se uma conta existe em fluxos sensíveis;

posicionar o foco no primeiro erro relevante;

exibir sucesso de forma inequívoca.

9.2 Formulário de login

No login, não aplique uma política de criação de senha ao valor informado. A senha existente pode seguir uma regra anterior. Valide apenas os requisitos necessários para o envio.

'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { apiClient } from '@/lib/http/api-client';
import { Button } from '@/components/ui/button';

const loginSchema = z.object({
  email: z.string().trim().email('Informe um e-mail válido.'),
  password: z.string().min(1, 'Informe sua senha.'),
});

type LoginFormData = z.infer<typeof loginSchema>;

export function LoginForm() {
  const router = useRouter();

  const {
    register,
    handleSubmit,
    setError,
    formState: {
      errors,
      isSubmitting,
    },
  } = useForm<LoginFormData>({
    resolver: zodResolver(loginSchema),
    defaultValues: {
      email: '',
      password: '',
    },
  });

  async function onSubmit(data: LoginFormData): Promise<void> {
    try {
      await apiClient.post('/auth/login', data);
      router.replace('/dashboard');
      router.refresh();
    } catch {
      setError('root', {
        message: 'E-mail ou senha inválidos.',
      });
    }
  }

  return (
    <form
      noValidate
      onSubmit={handleSubmit(onSubmit)}
      aria-busy={isSubmitting}
    >
      <div>
        <label htmlFor="email">E-mail</label>
        <input
          id="email"
          type="email"
          autoComplete="username"
          aria-invalid={Boolean(errors.email)}
          aria-describedby={errors.email ? 'email-error' : undefined}
          {...register('email')}
        />
        {errors.email ? (
          <p id="email-error" role="alert">
            {errors.email.message}
          </p>
        ) : null}
      </div>

      <div>
        <label htmlFor="password">Senha</label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          aria-invalid={Boolean(errors.password)}
          aria-describedby={errors.password ? 'password-error' : undefined}
          {...register('password')}
        />
        {errors.password ? (
          <p id="password-error" role="alert">
            {errors.password.message}
          </p>
        ) : null}
      </div>

      {errors.root ? (
        <p role="alert">
          {errors.root.message}
        </p>
      ) : null}

      <Button type="submit" isLoading={isSubmitting}>
        Entrar
      </Button>
    </form>
  );
}

 1. Componentes reutilizáveis

10.1 Botão com carregamento acessível

import {
  forwardRef,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';

interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  isLoading?: boolean;
  loadingLabel?: string;
  children: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      isLoading = false,
      loadingLabel = 'Processando',
      disabled,
      children,
      type = 'button',
      ...props
    },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type={type}
        disabled={disabled || isLoading}
        aria-disabled={disabled || isLoading}
        aria-busy={isLoading}
        {...props}
      >
        {isLoading ? (
          <>
            <Spinner aria-hidden="true" />
            <span>{loadingLabel}</span>
          </>
        ) : (
          children
        )}
      </button>
    );
  },
);

O texto do botão não deve desaparecer sem fornecer uma descrição alternativa ao leitor de tela.

10.2 Confirmação de operação destrutiva

Operações como exclusão, cancelamento e revogação devem pedir confirmação contextual.

<ConfirmDialog
  title="Excluir empresa?"
  description="Esta ação pode afetar usuários, documentos e relatórios associados."
  confirmLabel="Excluir empresa"
  confirmText={company.name}
  destructive
  onConfirm={deleteCompany}
/>

Para operações críticas, exija que o usuário digite um identificador ou nome conhecido.

 1. Debounce e busca

11.1 Hook reutilizável

'use client';

import { useEffect, useState } from 'react';

export function useDebouncedValue<T>(
  value: T,
  delay = 300,
): T {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setDebouncedValue(value);
    }, delay);

    return () => window.clearTimeout(timeoutId);
  }, [delay, value]);

  return debouncedValue;
}

11.2 Busca com cancelamento

'use client';

import { useEffect, useState } from 'react';
import { useDebouncedValue } from '@/hooks/use-debounced-value';

export function SearchCompanies() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Company[]>([]);
  const debouncedQuery = useDebouncedValue(query.trim(), 350);

  useEffect(() => {
    if (debouncedQuery.length < 2) {
      setResults([]);
      return;
    }

    const controller = new AbortController();

    request<Company[]>({
      method: 'GET',
      url: '/companies/search',
      params: {
        query: debouncedQuery,
      },
      signal: controller.signal,
    })
      .then(setResults)
      .catch(() => {
        if (!controller.signal.aborted) {
          setResults([]);
        }
      });

    return () => controller.abort();
  }, [debouncedQuery]);

  return (
    <div>
      <label htmlFor="company-search">Buscar empresa</label>
      <input
        id="company-search"
        type="search"
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
      />

      <SearchResults results={results} />
    </div>
  );
}

Não envie uma busca a cada tecla sem necessidade.

 1. Responsividade

12.1 Prefira CSS para layout

Não utilize JavaScript apenas para alternar a disposição visual.

Prefira:

.dashboard-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 1rem;
}

@media (min-width: 768px) {
  .dashboard-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (min-width: 1280px) {
  .dashboard-grid {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}

Use matchMedia somente quando o comportamento do componente realmente precisar mudar.

12.2 Hook de media query

'use client';

import { useEffect, useState } from 'react';

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia(query);

    function updateMatches(event?: MediaQueryListEvent): void {
      setMatches(event?.matches ?? mediaQuery.matches);
    }

    updateMatches();
    mediaQuery.addEventListener('change', updateMatches);

    return () => {
      mediaQuery.removeEventListener('change', updateMatches);
    };
  }, [query]);

  return matches;
}

Evite renderizar estruturas completamente diferentes no servidor com base na largura da tela, pois o servidor não conhece o tamanho real do navegador.

 1. Desempenho

13.1 Server Components por padrão

Utilize Client Components apenas quando precisar de:

eventos;

estado local;

efeitos;

contexto cliente;

window, document ou outras APIs do navegador.

Evite transformar páginas inteiras em Client Components por causa de um único botão interativo.

13.2 Carregamento dinâmico

Componentes clientes pesados podem ser carregados sob demanda.

'use client';

import dynamic from 'next/dynamic';

const HeavyChart = dynamic(
  () => import('./heavy-chart').then((module) => module.HeavyChart),
  {
    loading: () => <ChartSkeleton />,
    ssr: false,
  },
);

Utilize ssr: false somente quando o componente depender de APIs exclusivas do navegador.

13.3 Memoização com critério

Não utilize useMemo, useCallback ou memo automaticamente.

Aplique quando houver:

cálculo mensuravelmente caro;

referência estável exigida por dependência;

lista grande;

componente memoizado que recebe callback;

problema de renderização confirmado por medição.

Exemplo:

const filteredRows = useMemo(
  () => filterLargeDataset(rows, filters),
  [filters, rows],
);

13.4 Imagens

Utilize next/image quando aplicável:

import Image from 'next/image';

<Image
  src="/dashboard/overview.webp"
  alt="Visão geral do dashboard do SGS"
  width={1440}
  height={900}
  sizes="(max-width: 768px) 100vw, 70vw"
  priority
/>

Utilize priority apenas em imagens críticas acima da dobra.

13.5 Fontes

Utilize next/font para reduzir carregamentos externos e mudanças de layout.

13.6 Listas extensas

Para tabelas ou listas com milhares de registros:

paginação no servidor;

filtros no backend;

limite máximo por página;

virtualização quando necessária;

ordenação no backend;

seleção eficiente de colunas.

Não carregue todos os registros de todas as empresas no navegador.

 1. Acessibilidade

Todos os componentes devem atender, no mínimo:

navegação completa por teclado;

foco visível;

rótulos associados aos campos;

texto alternativo em imagens informativas;

elementos decorativos com aria-hidden="true";

mensagens dinâmicas com aria-live quando necessário;

erros com role="alert";

contraste legível;

tamanho de alvo adequado;

ordem lógica de foco;

respeito a prefers-reduced-motion;

tabelas com cabeçalhos e escopo;

modais com foco contido e devolvido ao elemento de origem.

Exemplo de redução de movimento:

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    scroll-behavior: auto !important;
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}

Não utilize apenas cor para representar:

sucesso;

erro;

prioridade;

risco;

situação de documento;

situação de treinamento.

Combine cor, texto e ícone semântico.

 1. Segurança no frontend

15.1 Variáveis públicas

Tudo que utiliza o prefixo abaixo pode chegar ao navegador:

NEXT_PUBLIC_

Nunca exponha:

DATABASE_URL
REDIS_URL
JWT_SECRET
ENCRYPTION_KEY
S3_SECRET_ACCESS_KEY
OPENAI_API_KEY
SENTRY_AUTH_TOKEN

15.2 HTML dinâmico

Evite:

<div dangerouslySetInnerHTML={{ __html: content }} />

Quando o uso for inevitável, sanitize o conteúdo com uma biblioteca apropriada e aplique uma Content Security Policy compatível.

15.3 URLs e redirecionamentos

Não redirecione diretamente para um valor fornecido pelo usuário.

Inseguro:

window.location.assign(searchParams.get('returnTo')!);

Melhor:

const allowedReturnPaths = new Set([
  '/dashboard',
  '/empresas',
  '/relatorios',
]);

const returnTo = searchParams.get('returnTo');
const safeReturnTo =
  returnTo && allowedReturnPaths.has(returnTo)
    ? returnTo
    : '/dashboard';

router.replace(safeReturnTo);

15.4 Downloads e uploads

Antes de enviar arquivos:

valide extensão;

valide MIME type;

limite tamanho;

apresente progresso;

permita cancelamento;

não confie apenas na validação do navegador;

não renderize conteúdo ativo sem proteção;

utilize URL assinada curta;

não exponha a chave do storage.

O backend deve repetir todas as validações.

15.5 Dados multiempresa

Não aceite companyId do navegador como prova de autorização.

Inseguro:

apiClient.get(`/companies/${localStorage.getItem('companyId')}/employees`);

O backend deve obter e validar o tenant a partir da sessão e das permissões do usuário.

 1. Logs e observabilidade

O frontend deve registrar erros úteis, mas sem dados sensíveis.

Pode registrar:

código da versão;

rota;

tipo de erro;

identificador da requisição;

navegador;

duração;

funcionalidade afetada.

Não deve registrar:

senha;

cookie;

token;

CPF completo;

exame médico;

laudo;

documento;

conteúdo de campo sensível;

imagem enviada;

resposta integral de IA com dados pessoais.

Exemplo:

captureException(error, {
  tags: {
    feature: 'company-registration',
    environment: process.env.NEXT_PUBLIC_APP_ENV,
  },
  extra: {
    requestId: appError.requestId,
  },
});

Configure mascaramento de dados antes do envio ao provedor de monitoramento.

 1. Testes

17.1 Testes unitários

Priorize:

validações;

formatação;

permissões de interface;

hooks;

transformação de dados;

componentes críticos.

17.2 Testes de integração

Valide:

formulários;

tratamento de erro;

estados de loading;

filtros;

paginação;

diálogos;

refresh de sessão;

navegação protegida.

17.3 Testes de ponta a ponta

Fluxos mínimos:

login;

MFA;

logout;

recuperação de senha;

troca de empresa;

criação e revogação de usuário;

criação de documento;

upload;

permissões;

isolamento multiempresa;

expiração da sessão;

acesso negado;

fluxo principal de cada módulo.

Um teste visual no frontend não substitui testes de autorização no backend.

 1. Organização recomendada

src/
├── app/
│   ├── (public)/
│   ├── (protected)/
│   ├── error.tsx
│   ├── global-error.tsx
│   ├── layout.tsx
│   └── not-found.tsx
├── components/
│   ├── common/
│   ├── layout/
│   └── ui/
├── features/
│   ├── auth/
│   │   ├── api/
│   │   ├── components/
│   │   ├── schemas/
│   │   └── types/
│   ├── companies/
│   ├── users/
│   └── reports/
├── hooks/
├── lib/
│   ├── auth/
│   ├── errors/
│   ├── http/
│   ├── monitoring/
│   └── validation/
├── styles/
├── types/
└── proxy.ts

Regras:

componentes específicos permanecem dentro da feature;

componentes genéricos ficam em components/ui;

chamadas HTTP não ficam diretamente espalhadas em páginas;

schemas de validação ficam próximos da feature;

tipos de API não devem ser duplicados;

arquivos cliente devem ser pequenos e explícitos.

 1. Checklist de revisão

Autenticação

Tokens não são armazenados em localStorage.

Cookies de sessão são configurados pelo servidor.

Requisições autenticadas enviam credenciais.

Refresh possui limite de uma tentativa.

Logout invalida a sessão no backend.

Rotas são verificadas no servidor.

O backend valida autorização e tenant.

MFA é exigido onde aplicável.

Redirecionamentos são validados.

Segurança

Nenhum secret utiliza NEXT_PUBLIC_*.

CORS permite apenas origens autorizadas.

Proteção CSRF está configurada quando necessária.

HTML externo é sanitizado.

Uploads possuem limite e validação.

Erros não revelam detalhes internos.

Logs não contêm dados pessoais ou sensíveis.

Operações destrutivas exigem confirmação.

IDs fornecidos pelo cliente são revalidados no backend.

Erros e estabilidade

Existe error.tsx nos segmentos críticos.

Existe global-error.tsx.

Existem estados de loading.

Existe estado vazio.

Requisições antigas são canceladas.

Erros HTTP são normalizados.

O usuário recebe um identificador de suporte quando disponível.

Falhas de widgets não derrubam a página inteira.

Formulários

Todos os campos possuem rótulo.

Erros estão associados aos campos.

O botão é bloqueado durante o envio.

O backend repete a validação.

Senhas não são registradas.

O foco é direcionado ao erro relevante.

O formulário preserva dados não sensíveis após falha.

Desempenho

Server Components são o padrão.

Client Components estão limitados ao necessário.

Componentes pesados são carregados sob demanda.

ssr: false é usado apenas por necessidade.

Imagens utilizam dimensões e sizes.

Listas grandes usam paginação.

Memoização foi aplicada com justificativa.

O bundle é monitorado.

Acessibilidade

Toda função é utilizável por teclado.

O foco está visível.

Modais gerenciam foco.

Ícones decorativos estão ocultos de leitores de tela.

Estados não dependem apenas de cor.

Animações respeitam redução de movimento.

Tabelas possuem cabeçalhos corretos.

Mensagens importantes são anunciadas.

Qualidade

TypeScript estrito está ativo.

Não existem any desnecessários.

Lint passa sem erros.

Build de produção passa.

Testes críticos passam.

Código morto foi removido.

Não existem logs temporários.

Componentes possuem responsabilidades claras.

 1. Práticas proibidas

Não utilizar no frontend do SGS:

token de autenticação em localStorage;

refresh token acessível por JavaScript;

autorização baseada apenas em interface;

companyId local como prova de tenant;

secrets em variáveis públicas;

mensagens técnicas completas para o usuário;

dangerouslySetInnerHTML com conteúdo não sanitizado;

any para evitar tipagem;

useEffect para toda busca sem avaliar Server Components;

useMemo e useCallback em todo componente;

layout responsivo dependente apenas de JavaScript;

requisições sem timeout;

busca sem debounce ou cancelamento;

botão de envio ativo durante processamento;

exclusão crítica sem confirmação;

dados sensíveis em logs ou ferramentas de analytics;

dependência exclusiva do frontend para segurança.

Última atualização: 4 de agosto de 2026.
