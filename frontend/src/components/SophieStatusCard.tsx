'use client';

import { useEffect, useState } from 'react';
import {
  Bot,
  BrainCircuit,
  Camera,
  CheckCircle2,
  Loader2,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { sophieService } from '@/services/sophieService';
import { isAiEnabled } from '@/lib/featureFlags';
import { logger } from '@/lib/logger';
import { useAiConsent } from '@/hooks/useAiConsent';
import { Button } from '@/components/ui/button';

type SophieStatus = {
  agent: {
    provider: string;
    officialProvider?: string;
    configured?: boolean;
    runtimeMode?: 'online' | 'degraded' | string;
    historyDefaultDays: number;
    historyMaxDays: number;
    historyMaxLimit: number;
    imageAnalysisEnabled: boolean;
    externalProviderEnabled: boolean;
    localFallbackEnabled: boolean;
  };
  knowledgeBase: {
    name: string;
    version: string;
    updated_at: string;
  };
  capabilities: Record<string, boolean>;
};

function formatProvider(provider: string) {
  switch (provider) {
    case 'openai':
      return 'OpenAI';
    case 'nvidia':
      return 'NVIDIA NIM';
    case 'stub':
      return 'Provedor de IA indisponível';
    default:
      return provider;
  }
}

function formatCapabilityLabel(key: string) {
  const labels: Record<string, string> = {
    insights: 'Insights',
    analyzeApr: 'Analise de APR',
    analyzePt: 'Analise de PT',
    analyzeChecklist: 'Analise de checklist',
    generateDds: 'Geracao de DDS',
    generateChecklist: 'Geracao de checklist',
    createChecklist: 'Checklist assistido',
    createDds: 'DDS assistido',
    createNonConformity: 'NC assistida',
    queueMonthlyReport: 'Relatorio mensal',
    chat: 'Chat operacional',
    history: 'Historico',
    imageAnalysis: 'Analise de imagens',
    llmProvider: 'Motor de IA externo',
    sstKnowledgeBase: 'Base tecnica SST',
  };
  return labels[key] || key;
}

export function SophieStatusCard() {
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<SophieStatus | null>(null);
  const { consentGiven, needsReacceptance, requestConsent, ConsentGate } = useAiConsent();

  useEffect(() => {
    let active = true;

    async function load() {
      if (!isAiEnabled() || !consentGiven) {
        setLoading(false);
        return;
      }

      try {
        const data = await sophieService.getStatus();
        if (!active) return;
        setStatus(data as SophieStatus);
      } catch (error) {
        logger.error('Erro ao carregar status da SOPHIE:', error);
      } finally {
        if (active) setLoading(false);
      }
    }

    void load();
    return () => {
      active = false;
    };
  }, [consentGiven]);

  if (!isAiEnabled()) return null;

  return (
    <div className="rounded-xl border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] p-6 shadow-[var(--ds-shadow-sm)]">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[var(--ds-color-action-primary)] text-white">
            <Bot className="h-6 w-6" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-[var(--ds-color-text-primary)]">SOPHIE</h2>
            <p className="text-sm text-[var(--ds-color-text-muted)]">
              Status operacional da SOPHIE no ambiente atual.
            </p>
          </div>
        </div>
        <span className="inline-flex items-center gap-1 rounded-full bg-[color:var(--ds-color-success)]/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--ds-color-success)]">
          <Sparkles className="h-3.5 w-3.5" />
          ativa
        </span>
      </div>

      {!consentGiven && !loading ? (
        <div className="mt-5 rounded-xl border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-elevated)] p-6 text-center">
          <BrainCircuit className="mx-auto mb-3 h-8 w-8 text-[var(--ds-color-text-muted)]" />
          <p className="mb-4 text-sm text-[var(--ds-color-text-secondary)]">
            {needsReacceptance
              ? 'Os termos de processamento por IA (LGPD) foram atualizados. Revise e aceite a nova versão para continuar usando a SOPHIE.'
              : 'Para visualizar o status detalhado da SOPHIE, é necessário aceitar os termos de processamento por IA (LGPD).'}
          </p>
          <Button variant="primary" onClick={requestConsent}>
            {needsReacceptance ? 'Revisar e aceitar novos termos' : 'Aceitar termos de IA'}
          </Button>
        </div>
      ) : loading ? (
        <div className="mt-5 flex min-h-40 items-center justify-center">
          <div className="flex items-center gap-2 text-sm text-[var(--ds-color-text-muted)]">
            <Loader2 className="h-4 w-4 animate-spin" />
            Carregando status da SOPHIE...
          </div>
        </div>
      ) : status ? (
        <div className="mt-5 space-y-5">
          <div className="grid gap-3 md:grid-cols-3">
            <div className="rounded-xl border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-elevated)] p-4">
              <div className="mb-2 flex items-center gap-2 text-[var(--ds-color-text-secondary)]">
                <BrainCircuit className="h-4 w-4" />
                <span className="text-xs font-semibold uppercase tracking-[0.12em]">
                  Motor oficial
                </span>
              </div>
              <p className="text-base font-semibold text-[var(--ds-color-text-primary)]">
                {formatProvider(status.agent.officialProvider || status.agent.provider)}
              </p>
              <p className="mt-1 text-xs text-[var(--ds-color-text-muted)]">
                {status.agent.configured
                  ? `${formatProvider(status.agent.officialProvider || status.agent.provider)} conectado como motor da SOPHIE neste ambiente.`
                  : `${formatProvider(status.agent.officialProvider || status.agent.provider)} definido, mas ainda indisponível neste ambiente.`}
              </p>
            </div>

            <div className="rounded-xl border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-elevated)] p-4">
              <div className="mb-2 flex items-center gap-2 text-[var(--ds-color-text-secondary)]">
                <Camera className="h-4 w-4" />
                <span className="text-xs font-semibold uppercase tracking-[0.12em]">
                  Analise visual
                </span>
              </div>
              <p className="text-base font-semibold text-[var(--ds-color-text-primary)]">
                {status.agent.imageAnalysisEnabled ? 'Habilitada' : 'Indisponivel'}
              </p>
              <p className="mt-1 text-xs text-[var(--ds-color-text-muted)]">
                {status.agent.imageAnalysisEnabled
                  ? 'Leitura visual pronta para apoiar inspeções, evidências e análises técnicas.'
                  : 'Indisponível para o modelo atual; fotos não são enviadas sem capacidade visual aprovada.'}
              </p>
            </div>

            <div className="rounded-xl border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-elevated)] p-4">
              <div className="mb-2 flex items-center gap-2 text-[var(--ds-color-text-secondary)]">
                <ShieldCheck className="h-4 w-4" />
                <span className="text-xs font-semibold uppercase tracking-[0.12em]">
                  Base tecnica SST
                </span>
              </div>
              <p className="text-base font-semibold text-[var(--ds-color-text-primary)]">
                {status.knowledgeBase.version ? 'Ativa' : 'Indisponivel'}
              </p>
              <p className="mt-1 text-xs text-[var(--ds-color-text-muted)]">
                KB {status.knowledgeBase.version} · {status.knowledgeBase.updated_at}
              </p>
            </div>
          </div>

          <div>
            <p className="mb-3 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ds-color-text-muted)]">
              Capacidades ativas
            </p>
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {Object.entries(status.capabilities)
                .filter(([, enabled]) => enabled)
                .map(([key]) => (
                  <div
                    key={key}
                    className="inline-flex items-center gap-2 rounded-lg border border-[color:var(--ds-color-success)]/25 bg-[color:var(--ds-color-success)]/8 px-3 py-2 text-sm text-[var(--ds-color-success)]"
                  >
                    <CheckCircle2 className="h-4 w-4" />
                    {formatCapabilityLabel(key)}
                  </div>
                ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="mt-5 rounded-xl border border-[color:var(--ds-color-warning)]/25 bg-[color:var(--ds-color-warning)]/8 p-4 text-sm text-[var(--ds-color-warning)]">
          Nao foi possivel consultar o status da SOPHIE neste momento.
        </div>
      )}
      <ConsentGate />
    </div>
  );
}
