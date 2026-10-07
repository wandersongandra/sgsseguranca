import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-[color:var(--color-background)] px-6 text-center">
      <div className="max-w-md rounded-2xl border border-[var(--color-border-subtle)] bg-[color:var(--component-card-bg-elevated)] p-8 shadow-[var(--ds-shadow-lg)]">
        <p className="text-5xl font-bold text-[var(--ds-color-action-primary)]">404</p>
        <h1 className="mt-3 text-lg font-bold text-[var(--color-text)]">
          Página não encontrada
        </h1>
        <p className="mt-2 text-sm text-[var(--color-text-secondary)]">
          O endereço que você acessou não existe ou foi movido.
        </p>
        <Link
          href="/dashboard"
          className="mt-6 inline-block rounded-xl bg-[color:var(--component-button-primary-bg)] px-6 py-2.5 text-sm font-semibold text-[var(--component-button-primary-text)] transition-colors hover:bg-[color:var(--component-button-primary-hover-bg)]"
        >
          Voltar ao início
        </Link>
      </div>
    </div>
  );
}
