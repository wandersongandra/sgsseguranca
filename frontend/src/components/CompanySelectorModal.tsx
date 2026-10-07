'use client';

import { useDeferredValue, useMemo, useState, useEffect } from 'react';
import { Building2, Search, LogOut, ChevronRight, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { companiesService, Company } from '@/services/companiesService';
import { selectedTenantStore } from '@/lib/selectedTenantStore';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { StatusPill } from './ui/status-pill';
import {
  ModalBody,
  ModalFooter,
  ModalFrame,
  ModalHeader,
} from './ui/modal-frame';

interface Props {
  open: boolean;
  onSelect: (company: Company) => void;
  onLogout: () => void;
  currentCompanyId?: string | null;
  onClose?: () => void;
}

export default function CompanySelectorModal({ open, onSelect, onLogout, currentCompanyId, onClose }: Props) {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);

  const filteredCompanies = useMemo(() => {
    const term = deferredSearch.trim().toLowerCase();
    if (!term) return companies;

    return companies.filter((company) =>
      [company.razao_social, company.cnpj, company.responsavel]
        .filter(Boolean)
        .some((value) => value.toLowerCase().includes(term)),
    );
  }, [companies, deferredSearch]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setLoadFailed(false);
    companiesService
      .findAll()
      .then((response) => {
        if (cancelled) return;
        setCompanies(response);
        setLoadFailed(false);
      })
      .catch(() => {
        if (cancelled) return;
        setCompanies([]);
        setLoadFailed(true);
        toast.error('Não foi possível carregar a lista de empresas.');
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open]);
  const canDismiss = Boolean(currentCompanyId && onClose);

  return (
    <ModalFrame
      isOpen={open}
      onClose={canDismiss ? onClose! : () => {}}
      shellClassName="mx-4 max-w-lg"
      overlayClassName="z-50"
    >
      <ModalHeader
        title="Selecionar empresa"
        description="Escolha a empresa para operar como Administrador Geral."
        icon={<Building2 className="h-5 w-5" />}
        onClose={canDismiss ? onClose : undefined}
      />

      <ModalBody className="space-y-4">
        <div>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--ds-color-text-muted)]" />
            <Input
              type="text"
              placeholder="Buscar empresa..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
              autoFocus
            />
          </div>
        </div>

        <div className="max-h-[min(50dvh,24rem)] overflow-y-auto overscroll-contain">
          {loading ? (
            <div className="flex items-center justify-center py-10 text-[var(--ds-color-text-muted)]">
              <Loader2 className="mr-2 h-6 w-6 animate-spin" />
              <span className="text-sm">Carregando empresas...</span>
            </div>
          ) : loadFailed ? (
            <p className="py-8 text-center text-sm text-[var(--ds-color-danger)]">
              Falha ao carregar empresas.
            </p>
          ) : filteredCompanies.length === 0 ? (
            <p className="py-8 text-center text-sm text-[var(--ds-color-text-muted)]">
              {search ? 'Nenhuma empresa encontrada.' : 'Sem empresas cadastradas.'}
            </p>
          ) : (
            <ul className="mt-1 space-y-2">
              {filteredCompanies.map((company) => {
                const isActive = company.id === currentCompanyId;
                return (
                  <li key={company.id}>
                    <button
                      onClick={async () => {
                        await selectedTenantStore.set({ companyId: company.id, companyName: company.razao_social });
                        onSelect(company);
                      }}
                      className={`flex min-h-11 w-full items-center justify-between rounded-[var(--ds-radius-md)] border px-3.5 py-3 text-left transition-colors sm:px-4 ${
                        isActive
                          ? 'border-[color:var(--ds-color-action-primary)]/18 bg-[var(--ds-color-primary-subtle)]'
                          : 'border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] hover:border-[var(--ds-color-border-default)] hover:bg-[var(--ds-color-surface-muted)]/18'
                      }`}
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        <div className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[var(--ds-radius-md)] ${
                          isActive ? 'bg-[var(--ds-color-primary-subtle)] text-[var(--ds-color-action-primary)]' : 'bg-[var(--ds-color-surface-muted)]/35 text-[var(--ds-color-text-muted)]'
                        }`}>
                          <Building2 className="h-4 w-4" />
                        </div>
                        <div className="min-w-0">
                          <p className={`truncate text-sm font-medium ${isActive ? 'text-[var(--ds-color-action-primary)]' : 'text-[var(--ds-color-text-primary)]'}`}>
                            {company.razao_social}
                          </p>
                          <p className="truncate text-xs text-[var(--ds-color-text-muted)]">CNPJ: {company.cnpj}</p>
                        </div>
                      </div>
                      {isActive ? (
                        <StatusPill tone="primary" className="ml-2 flex-shrink-0">
                          Atual
                        </StatusPill>
                      ) : (
                        <ChevronRight className="ml-2 h-4 w-4 flex-shrink-0 text-[var(--ds-color-text-muted)]" />
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </ModalBody>

      <ModalFooter className="items-center justify-between">
        <span className="text-xs text-[var(--ds-color-text-muted)]">
          {companies.length} empresa{companies.length !== 1 ? 's' : ''} cadastrada{companies.length !== 1 ? 's' : ''}
        </span>
        <Button
          type="button"
          onClick={onLogout}
          variant="ghost"
          className="gap-2 text-[var(--ds-color-danger)] hover:text-[var(--ds-color-danger)]"
        >
          <LogOut className="h-4 w-4" />
          Sair
        </Button>
      </ModalFooter>
    </ModalFrame>
  );
}
