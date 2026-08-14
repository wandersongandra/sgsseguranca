import { clearSensitiveBrowserStorage } from "./browser-sensitive-storage";
import { siteStore } from "./siteStore";
import { sessionStore } from "./sessionStore";

type SelectedTenant = {
  companyId: string;
  companyName: string;
};

type Listener = (tenant: SelectedTenant | null) => void;

const STORAGE_KEY = "cx_selected_tenant";

let current: SelectedTenant | null = null;
const listeners = new Set<Listener>();
let transition = Promise.resolve();

function isValidTenant(value: unknown): value is SelectedTenant {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.companyId === "string" &&
    v.companyId.length > 0 &&
    typeof v.companyName === "string"
  );
}

function loadFromStorage(): SelectedTenant | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isValidTenant(parsed)) {
      sessionStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return parsed;
  } catch {
    sessionStorage.removeItem(STORAGE_KEY);
    return null;
  }
}

function saveToStorage(tenant: SelectedTenant | null) {
  if (typeof window === "undefined") return;
  if (tenant) {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(tenant));
  } else {
    sessionStorage.removeItem(STORAGE_KEY);
  }
}

export const selectedTenantStore = {
  get(): SelectedTenant | null {
    if (!current && typeof window !== "undefined") {
      current = loadFromStorage();
    }
    return current;
  },

  set(tenant: SelectedTenant): Promise<void> {
    transition = transition.then(async () => {
      const previousTenant = current ?? loadFromStorage();
      if (
        previousTenant?.companyId &&
        previousTenant.companyId !== tenant.companyId
      ) {
        // Invalidar imediatamente itens offline do tenant anterior, antes da
        // limpeza assíncrona de IndexedDB terminar.
        sessionStore.rotateGeneration();
        await clearSensitiveBrowserStorage();
        // Quando a empresa muda, limpa a obra selecionada também
        siteStore.clear();
      }
      current = tenant;
      saveToStorage(tenant);
      for (const l of listeners) l(current);
    });
    return transition;
  },

  clear() {
    current = null;
    saveToStorage(null);
    for (const l of listeners) l(null);
  },

  subscribe(listener: Listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
