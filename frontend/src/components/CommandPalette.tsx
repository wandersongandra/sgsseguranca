'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Command, FileText, Loader2, Search, UserRound, X } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { isAiEnabled } from '@/lib/featureFlags';
import { getVisibleNavigationItems } from '@/lib/navigation-config';
import { Permission } from '@/lib/permissions';
import { selectedTenantStore } from '@/lib/selectedTenantStore';
import { cn } from '@/lib/utils';
import { aprsService } from '@/services/aprsService';
import { usersService } from '@/services/usersService';

type SearchResult = { id: string; title: string; subtitle: string; href: string; group: 'APR' | 'Usuário'; tenantId: string };
const DEBOUNCE_MS = 300;
const LISTBOX_ID = 'command-palette-results';

export function CommandPalette() {
  const router = useRouter();
  const { user, hasPermission, isAdminGeral } = useAuth();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState(0);
  const [selectedTenantId, setSelectedTenantId] = useState(
    () => selectedTenantStore.get()?.companyId ?? null,
  );
  const dialogRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortController = useRef<AbortController | null>(null);
  const requestVersion = useRef(0);

  const canSearchUsers = isAdminGeral || hasPermission(Permission.CAN_MANAGE_USERS);
  const canSearchAprs = isAdminGeral || hasPermission(Permission.CAN_VIEW_APR);
  const tenantId = isAdminGeral ? selectedTenantId : user?.company_id ?? null;
  const scopeKey = `${tenantId ?? 'none'}:${canSearchAprs}:${canSearchUsers}`;
  const currentScope = useRef(scopeKey);
  currentScope.current = scopeKey;

  const invalidateSearch = useCallback(() => {
    requestVersion.current += 1;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    abortController.current?.abort();
    abortController.current = null;
  }, []);

  const close = useCallback(() => {
    invalidateSearch();
    setSearching(false);
    setOpen(false);
  }, [invalidateSearch]);
  useFocusTrap(dialogRef, open, close);

  useEffect(() => {
    const unsubscribe = selectedTenantStore.subscribe((tenant) => {
      invalidateSearch();
      setSelectedTenantId(tenant?.companyId ?? null);
    });
    return () => { unsubscribe(); };
  }, [invalidateSearch]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((value) => {
          if (value) invalidateSearch();
          return !value;
        });
      }
    };
    const toggle = () => setOpen((value) => {
      if (value) invalidateSearch();
      return !value;
    });
    const show = () => setOpen(true);
    window.addEventListener('keydown', keydown);
    window.addEventListener('app:command-palette-toggle', toggle);
    window.addEventListener('app:command-palette-open', show);
    return () => {
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('app:command-palette-toggle', toggle);
      window.removeEventListener('app:command-palette-open', show);
      invalidateSearch();
    };
  }, [invalidateSearch]);

  const commands = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('pt-BR');
    return getVisibleNavigationItems('command', {
      hasPermission,
      isAdmin: isAdminGeral,
      featureFlags: { ai: isAiEnabled() },
    }).filter((entry) => !normalized || [entry.label, entry.description, ...(entry.keywords ?? [])].filter(Boolean).join(' ').toLocaleLowerCase('pt-BR').includes(normalized));
  }, [hasPermission, isAdminGeral, query]);

  useEffect(() => {
    invalidateSearch();
    const term = query.trim();
    if (!open || term.length < 2 || !tenantId || (!canSearchAprs && !canSearchUsers)) {
      setResults([]);
      setSearching(false);
      return;
    }

    const version = requestVersion.current;
    const requestedScope = scopeKey;
    setSearching(true);
    timer.current = setTimeout(async () => {
      const controller = new AbortController();
      abortController.current = controller;
      const requests: Promise<unknown>[] = [];
      if (canSearchAprs) {
        requests.push(aprsService.findPaginated({
          search: term,
          limit: 4,
          companyId: tenantId,
          signal: controller.signal,
        }));
      }
      if (canSearchUsers) {
        requests.push(usersService.findPaginated({
          search: term,
          limit: 4,
          companyId: tenantId,
          signal: controller.signal,
        }));
      }

      const settled = await Promise.allSettled(requests);
      if (controller.signal.aborted || version !== requestVersion.current || requestedScope !== currentScope.current) return;

      const next: SearchResult[] = [];
      let resultIndex = 0;
      if (canSearchAprs) {
        const aprs = settled[resultIndex++];
        if (aprs?.status === 'fulfilled') {
          (aprs.value as Awaited<ReturnType<typeof aprsService.findPaginated>>).data
            .filter((apr) => apr.company_id === tenantId)
            .forEach((apr) => next.push({ id: `apr-${apr.id}`, title: `APR ${apr.numero} — ${apr.titulo}`, subtitle: apr.status, href: `/dashboard/aprs/${apr.id}`, group: 'APR', tenantId }));
        }
      }
      if (canSearchUsers) {
        const users = settled[resultIndex];
        if (users?.status === 'fulfilled') {
          (users.value as Awaited<ReturnType<typeof usersService.findPaginated>>).data
            .filter((candidate) => candidate.company_id === tenantId)
            .forEach((candidate) => next.push({ id: `user-${candidate.id}`, title: candidate.nome, subtitle: candidate.email, href: `/dashboard/users/${candidate.id}`, group: 'Usuário', tenantId }));
        }
      }
      setResults(next);
      setSearching(false);
      abortController.current = null;
    }, DEBOUNCE_MS);

    return invalidateSearch;
  }, [canSearchAprs, canSearchUsers, invalidateSearch, open, query, scopeKey, tenantId]);

  useEffect(() => { setSelected(0); }, [query, results.length, scopeKey]);
  useEffect(() => {
    if (!open) {
      setQuery('');
      setResults([]);
      setSearching(false);
    }
  }, [open]);

  const visibleResults = results.filter((result) =>
    result.tenantId === tenantId &&
    (result.group === 'APR' ? canSearchAprs : canSearchUsers),
  );
  const choices = [...visibleResults, ...commands];
  const activeOptionId = choices[selected] ? `command-palette-option-${choices[selected]!.id}` : undefined;
  const choose = (href: string) => { close(); router.push(href); };
  const changeQuery = (value: string) => {
    invalidateSearch();
    setQuery(value);
  };
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center bg-[color:var(--component-command-overlay)] px-[max(0.75rem,var(--ds-safe-area-left))] pb-[max(0.75rem,var(--ds-safe-area-bottom))] pt-[max(0.75rem,var(--ds-safe-area-top))] backdrop-blur-sm sm:px-4 sm:pt-[10vh]" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Paleta de comandos" className="flex max-h-[calc(100dvh-max(1.5rem,var(--ds-safe-area-top)+var(--ds-safe-area-bottom)))] w-full max-w-[42rem] flex-col overflow-hidden rounded-[var(--ds-radius-lg)] border border-[var(--component-command-border)] bg-[color:var(--component-command-bg)] shadow-[var(--ds-shadow-lg)]">
        <div className="flex items-center gap-3 border-b border-[var(--color-border-subtle)] px-4 py-3.5">
          {searching ? <Loader2 aria-hidden="true" className="h-5 w-5 animate-spin" /> : <Search aria-hidden="true" className="h-5 w-5" />}
          <input
            autoFocus
            value={query}
            onChange={(event) => changeQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' && choices.length) { event.preventDefault(); setSelected((value) => (value + 1) % choices.length); }
              if (event.key === 'ArrowUp' && choices.length) { event.preventDefault(); setSelected((value) => (value - 1 + choices.length) % choices.length); }
              if (event.key === 'Enter' && choices[selected]) { event.preventDefault(); choose(choices[selected]!.href); }
            }}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls={LISTBOX_ID}
            aria-activedescendant={activeOptionId}
            aria-label="Buscar ações rápidas"
            placeholder="Buscar módulo, APR, usuário ou ação..."
            className="min-w-0 flex-1 border-0 bg-transparent text-[15px] outline-none"
          />
          <button type="button" onClick={close} aria-label="Fechar busca" className="flex h-9 w-9 items-center justify-center rounded-[var(--ds-radius-md)] hover:bg-[var(--ds-color-surface-muted)]"><X aria-hidden="true" className="h-4 w-4" /></button>
        </div>
        <div id={LISTBOX_ID} role="listbox" aria-label="Resultados" className="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain p-2.5 sm:max-h-[28rem]">
          {choices.length === 0 && !searching ? <div className="p-7 text-center"><Command aria-hidden="true" className="mx-auto h-9 w-9" /><p>Nenhum resultado encontrado</p></div> : null}
          {visibleResults.map((result, index) => {
            const Icon = result.group === 'APR' ? FileText : UserRound;
            return <button id={`command-palette-option-${result.id}`} role="option" aria-selected={selected === index} key={result.id} type="button" onClick={() => choose(result.href)} className={cn('flex w-full items-center gap-3 rounded-[var(--ds-radius-md)] border px-3.5 py-2.5 text-left', selected === index ? 'border-[var(--ds-color-primary-border)] bg-[var(--ds-color-primary-subtle)]' : 'border-transparent hover:bg-[var(--ds-color-surface-muted)]')}><Icon aria-hidden="true" className="h-4 w-4" /><span className="min-w-0"><strong className="block break-words text-[13px]">{result.title}</strong><span className="block break-words text-[11px]">{result.subtitle}</span></span></button>;
          })}
          {commands.map((entry, index) => {
            const Icon = entry.icon;
            const choiceIndex = visibleResults.length + index;
            return <button id={`command-palette-option-${entry.id}`} role="option" aria-selected={selected === choiceIndex} key={entry.id} type="button" onClick={() => choose(entry.href)} className={cn('flex w-full items-center gap-3 rounded-[var(--ds-radius-md)] border px-3.5 py-2.5 text-left', selected === choiceIndex ? 'border-[var(--ds-color-primary-border)] bg-[var(--ds-color-primary-subtle)]' : 'border-transparent hover:bg-[var(--ds-color-surface-muted)]')}><Icon aria-hidden="true" className="h-4 w-4" /><span className="min-w-0"><strong className="block break-words text-[13px]">Abrir {entry.label}</strong><span className="block break-words text-[11px]">{entry.description ?? entry.section}</span></span></button>;
          })}
        </div>
      </div>
    </div>
  );
}
