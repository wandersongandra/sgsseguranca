'use client';

import { clearSensitiveBrowserStorage } from './browser-sensitive-storage';

export type SelectedSite = {
  siteId: string;
  siteName: string;
  companyId: string;
};

type Listener = (site: SelectedSite | null) => void;

const STORAGE_KEY = 'cx_selected_site';

let current: SelectedSite | null = null;
const listeners = new Set<Listener>();
let transition = Promise.resolve();
let transitionVersion = 0;

function isValidSite(value: unknown): value is SelectedSite {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.siteId === 'string' &&
    v.siteId.length > 0 &&
    typeof v.siteName === 'string' &&
    typeof v.companyId === 'string' &&
    v.companyId.length > 0
  );
}

function loadFromStorage(): SelectedSite | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isValidSite(parsed)) {
      sessionStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return parsed;
  } catch {
    sessionStorage.removeItem(STORAGE_KEY);
    return null;
  }
}

function saveToStorage(site: SelectedSite | null) {
  if (typeof window === 'undefined') return;
  if (site) {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(site));
  } else {
    sessionStorage.removeItem(STORAGE_KEY);
  }
}

/**
 * Store global para a obra ativa selecionada.
 *
 * Este store gerencia o estado da obra selecionada no frontend,
 * permitindo que toda a aplicação conheça a obra ativa atual.
 *
 * Quando a obra é alterada:
 * 1. Invalida caches sensíveis (dados da obra anterior)
 * 2. Notifica todos os listeners
 * 3. Limpa dados em memória que possam estar desatualizados
 */
export const siteStore = {
  get(): SelectedSite | null {
    if (!current && typeof window !== 'undefined') {
      current = loadFromStorage();
    }
    return current;
  },

  set(site: SelectedSite): Promise<void> {
    const requestedVersion = transitionVersion;
    const applySite = async () => {
      if (requestedVersion !== transitionVersion) return;
      const previousSite = current ?? loadFromStorage();

      // Se mudou a empresa ou a obra, limpa dados sensíveis
      if (
        previousSite?.siteId &&
        (previousSite.companyId !== site.companyId || previousSite.siteId !== site.siteId)
      ) {
        await clearSensitiveBrowserStorage();
      }

      if (requestedVersion !== transitionVersion) return;
      current = site;
      saveToStorage(site);
      for (const l of listeners) l(current);
    };
    transition = transition.then(applySite, applySite);
    return transition;
  },

  /**
   * Limpa a obra selecionada.
   * Usado quando o usuário faz logout ou precisa redefinir o contexto.
   */
  clear() {
    transitionVersion += 1;
    current = null;
    saveToStorage(null);
    for (const l of listeners) l(null);
  },

  /**
   * Inscreve um listener para mudanças na obra selecionada.
   * Retorna função para cancelar a inscrição.
   */
  subscribe(listener: Listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  /**
   * Verifica se uma obra específica está selecionada.
   */
  isSelected(siteId: string): boolean {
    return current?.siteId === siteId;
  },

  /**
   * Atualiza apenas o nome da obra (útil quando o nome muda no backend).
   */
  updateSiteName(siteName: string) {
    if (current) {
      current = { ...current, siteName };
      saveToStorage(current);
      for (const l of listeners) l(current);
    }
  },
};
