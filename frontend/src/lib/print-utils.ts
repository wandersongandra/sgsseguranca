import { safeExternalArtifactUrl } from "@/lib/security/safe-external-url";

const BLOB_URL_REVOKE_DELAY_MS = 60_000;

function revokeBlobUrlLater(url: string): void {
  if (!url.startsWith("blob:")) return;

  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, BLOB_URL_REVOKE_DELAY_MS);
}

export function resolveSafeBrowserUrl(rawUrl: string): string {
  const safeUrl = safeExternalArtifactUrl(rawUrl);
  if (!safeUrl) {
    throw new Error("URL bloqueada pela política de segurança.");
  }
  return safeUrl;
}

export function openUrlInNewTab(rawUrl: string, onPopupBlocked?: () => void) {
  const safeUrl = resolveSafeBrowserUrl(rawUrl);
  const openedWindow = window.open(safeUrl, "_blank", "noopener,noreferrer");
  revokeBlobUrlLater(safeUrl);

  if (openedWindow) {
    return true;
  }

  onPopupBlocked?.();
  return false;
}

export function preparePdfPrintWindow(): Window | null {
  const printWindow = window.open("about:blank", "_blank");
  if (printWindow) {
    printWindow.opener = null;
  }

  return printWindow;
}

export const openPdfForPrint = (
  fileURL: string,
  onPopupBlocked?: () => void,
  preparedWindow?: Window | null,
) => {
  const safeUrl = resolveSafeBrowserUrl(fileURL);
  revokeBlobUrlLater(safeUrl);
  const printWindow = preparedWindow ?? window.open("about:blank", "_blank");

  if (printWindow) {
    printWindow.opener = null;

    const runPrint = () => {
      try {
        printWindow.focus();
        printWindow.print();
      } catch {
        // noop
      }
    };

    if (typeof printWindow.addEventListener === "function") {
      printWindow.addEventListener("load", runPrint, { once: true });
    } else {
      setTimeout(runPrint, 500);
    }

    printWindow.location.href = safeUrl;

    return true;
  }

  onPopupBlocked?.();
  return false;
};
