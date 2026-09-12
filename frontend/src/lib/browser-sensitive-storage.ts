import { secureOfflineDB } from "./offline-db-secure";
import { clearOfflineCache } from "./offline-cache";

const SENSITIVE_STORAGE_PREFIXES = [
  "gst.cache.",
  "compliancex.cache.",
  "gst.apr.wizard.draft.",
  "compliancex.apr.wizard.draft.",
  "gst.pt.wizard.draft.",
  "compliancex.pt.wizard.draft.",
  "gst.nc.sophie.preview.",
  "checklist.form.draft.",
];

const SENSITIVE_STORAGE_KEYS = [
  "gst.offline.queue",
  "compliancex.offline.queue",
];

export async function clearSensitiveBrowserStorage(): Promise<void> {
  if (typeof window === "undefined") return;

  // Tenant changes must invalidate encrypted records as well as legacy storage.
  // These stores may contain cached entities, queued writes, or session context.
  await Promise.all([
    clearOfflineCache(),
    secureOfflineDB.clear("sgs-queue"),
    secureOfflineDB.clear("sgs-session"),
  ]);

  for (const key of SENSITIVE_STORAGE_KEYS) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // best effort
    }
  }

  for (const storage of [window.localStorage, window.sessionStorage]) {
    try {
      for (let index = storage.length - 1; index >= 0; index -= 1) {
        const key = storage.key(index);
        if (!key) continue;
        if (SENSITIVE_STORAGE_PREFIXES.some((prefix) => key.startsWith(prefix))) {
          storage.removeItem(key);
        }
      }
    } catch {
      // best effort
    }
  }
}
