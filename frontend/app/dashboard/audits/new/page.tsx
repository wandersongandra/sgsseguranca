'use client';

import { AuditForm } from '@/components/AuditForm';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';

export default function NewAuditPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center space-x-4">
        <Link
          href="/dashboard/audits"
          className="rounded-lg border border-[var(--ds-color-border-default)] p-2 text-[var(--ds-color-text-muted)] hover:bg-[var(--ds-color-surface-elevated)] hover:text-[var(--ds-color-text-secondary)]"
        >
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-[var(--ds-color-text-primary)]">Novo Relatório de Auditoria ou Inspeção HSE</h1>
          <p className="text-sm text-[var(--ds-color-text-muted)]">Registre uma avaliação formal de conformidade ou inspeção estruturada no fluxo governado.</p>
        </div>
      </div>

      <AuditForm />
    </div>
  );
}
