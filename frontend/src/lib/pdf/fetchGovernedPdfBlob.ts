import api from "@/lib/api";
import { resolveSafeBrowserUrl } from "@/lib/print-utils";

/**
 * O link de download de um PDF governado é assinado e de uso único,
 * vinculado à sessão que o emitiu (o backend exige o header Authorization
 * na própria requisição que consome o token — ver
 * document-download-grant.service.ts::consumeToken, que amarra o consumo a
 * `req.tenant.userId`, populado só a partir do Bearer header). Uma
 * navegação crua (window.open direto na URL) nunca carrega esse header, já
 * que é uma navegação de página, não uma chamada autenticada pelo client
 * `api` — então o token é sempre rejeitado com "Token de download
 * inválido, expirado ou já consumido.", mesmo sendo a primeira tentativa.
 * Por isso buscamos com o client autenticado (que anexa o Bearer token) e
 * trabalhamos com o PDF como blob local. Mesmo padrão já usado em
 * StoredFilesPanel.tsx para o mesmo problema.
 */
export async function fetchGovernedPdfBlob(
  url: string,
): Promise<{ blob: Blob; filename: string | null }> {
  const safeUrl = resolveSafeBrowserUrl(url);
  const response = await api.get<Blob>(safeUrl, { responseType: "blob" });
  const contentDisposition = response.headers?.["content-disposition"];
  const match =
    typeof contentDisposition === "string"
      ? contentDisposition.match(/filename="([^"]+)"/)
      : null;
  let filename: string | null = null;
  if (match?.[1]) {
    try {
      filename = decodeURIComponent(match[1]);
    } catch {
      filename = match[1];
    }
  }
  return { blob: response.data, filename };
}
