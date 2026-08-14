'use client';

import { useDeferredValue, useMemo, useState, useEffect } from 'react';
import { Building, Search, Loader2, HardHat } from 'lucide-react';
import { toast } from 'sonner';
import { sitesService, Site } from '@/services/sitesService';
import { siteStore } from '@/lib/siteStore';
import { logger } from '@/lib/logger';
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
  onSelect: (site: Site) => void;
  currentCompanyId: string;
  currentSiteId?: string | null;
  onClose?: () => void;
}

/**
 * Modal para seleção de obra.
 *
 * Permite ao usuário selecionar uma obra para trabalhar.
 * As obras listadas são filtradas pelo backend para mostrar apenas
 * aquelas às quais o usuário está vinculado.
 *
 * O contexto de obra é crítico para:
 * - Isolamento de dados entre obras
 * - Cálculo correto de indicadores e pendências
 * - Restrição de acesso a registros específicos
 */
export default function SiteSelectorModal({
  open,
  onSelect,
  currentCompanyId,
  currentSiteId,
  onClose,
}: Props) {
  const [search, setSearch] = useState('');
  const [sites, setSites] = useState<Site[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  const deferredSearch = useDeferredValue(search);

  useEffect(() => {
    if (!open || !currentCompanyId) {
      setSites([]);
      return;
    }

    let cancelled = false;

    async function loadSites() {
      setLoading(true);
      setLoadFailed(false);

      try {
        // O backend já filtra as obras pelo escopo do usuário
        const result = await sitesService.findAll(currentCompanyId);

        if (!cancelled) {
          setSites(result || []);
        }
      } catch (error) {
        if (!cancelled) {
          logger.error('Falha ao carregar obras:', error);
          setLoadFailed(true);
          toast.error('Não foi possível carregar a lista de obras.');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    loadSites();

    return () => {
      cancelled = true;
    };
  }, [open, currentCompanyId]);

  const filteredSites = useMemo(() => {
    if (!deferredSearch) return sites;

    const searchLower = deferredSearch.toLowerCase();
    return sites.filter(
      (site) =>
        (site.nome ?? '').toLowerCase().includes(searchLower) ||
        site.cidade?.toLowerCase().includes(searchLower) ||
        site.endereco?.toLowerCase().includes(searchLower)
    );
  }, [sites, deferredSearch]);

  const handleSelect = (site: Site) => {
    // Atualiza o store global de site
    siteStore.set({
      siteId: site.id,
      siteName: site.nome,
      companyId: site.company_id,
    });

    onSelect(site);
    onClose?.();

    // Feedback visual
    toast.success(`Obra "${site.nome}" selecionada`, {
      description: 'Contexto de trabalho atualizado',
    });
  };

  return (
    <ModalFrame isOpen={open} onClose={() => onClose?.()}>
      <ModalHeader
        title="Selecionar Obra"
        icon={<HardHat className="h-5 w-5 text-amber-600" />}
      />

      <ModalBody className="max-h-[60vh]">
        <div className="space-y-4">
          {/* Campo de busca */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--ds-color-text-muted)]" />
            <Input
              placeholder="Buscar obra por nome, cidade ou endereço..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
              disabled={loading}
            />
          </div>

          {/* Lista de obras */}
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-[var(--ds-color-text-muted)]" />
              <span className="ml-2 text-[var(--ds-color-text-muted)]">Carregando obras...</span>
            </div>
          ) : loadFailed ? (
            <div className="text-center py-8 text-[var(--ds-color-text-muted)]">
              <p>Não foi possível carregar as obras.</p>
              <Button
                variant="link"
                onClick={() => setLoadFailed(false)}
                className="mt-2"
              >
                Tentar novamente
              </Button>
            </div>
          ) : filteredSites.length === 0 ? (
            <div className="text-center py-8 text-[var(--ds-color-text-muted)]">
              {search ? (
                <p>Nenhuma obra encontrada para &quot;{search}&quot;</p>
              ) : (
                <p>Nenhuma obra disponível para esta empresa.</p>
              )}
            </div>
          ) : (
            <ul className="space-y-2 max-h-[300px] overflow-y-auto">
              {filteredSites.map((site) => (
                <li key={site.id}>
                  <button
                    type="button"
                    onClick={() => handleSelect(site)}
                    className={`
                      w-full text-left p-3 rounded-lg border transition-colors
                      ${
                        currentSiteId === site.id
                          ? 'border-amber-500 bg-amber-50 dark:bg-amber-950/30'
                          : 'border-[var(--ds-color-border-subtle)] hover:bg-[var(--ds-color-surface-muted)]/50'
                      }
                    `}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex items-start gap-3">
                        <div
                          className={`
                            p-2 rounded-lg
                            ${
                              currentSiteId === site.id
                                ? 'bg-amber-100 dark:bg-amber-900'
                                : 'bg-[var(--ds-color-surface-muted)]'
                            }
                          `}
                        >
                          <Building
                            className={`
                              h-4 w-4
                              ${
                                currentSiteId === site.id
                                  ? 'text-amber-600'
                                  : 'text-[var(--ds-color-text-muted)]'
                              }
                            `}
                          />
                        </div>
                        <div>
                          <div className="font-medium">{site.nome}</div>
                          {(site.cidade || site.endereco) && (
                            <div className="text-sm text-[var(--ds-color-text-muted)]">
                              {[site.cidade, site.estado]
                                .filter(Boolean)
                                .join(' - ')}
                              {site.endereco && ` - ${site.endereco}`}
                            </div>
                          )}
                        </div>
                      </div>
                      {currentSiteId === site.id && (
                        <StatusPill tone="success">Atual</StatusPill>
                      )}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </ModalBody>

      <ModalFooter className="items-center justify-between">
        <span className="text-xs text-[var(--ds-color-text-muted)]">
          {filteredSites.length} obra{filteredSites.length !== 1 ? 's' : ''}{' '}
          disponível{filteredSites.length !== 1 ? 'is' : ''}
        </span>
        <Button variant="ghost" onClick={() => onClose?.()}>
          Cancelar
        </Button>
      </ModalFooter>
    </ModalFrame>
  );
}
