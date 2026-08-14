import { logger } from "@/lib/logger";

export async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = String(reader.result || '');
      const base64 = result.includes(',') ? result.split(',')[1] : result;
      if (!base64) {
        reject(new Error('Falha ao converter PDF para base64.'));
        return;
      }
      resolve(base64);
    };
    reader.onerror = () =>
      reject(new Error('Falha ao ler o PDF armazenado para envio.'));
    reader.readAsDataURL(blob);
  });
}

/** Converte um Blob em uma Data URL (base64 com prefixo mime) */
export async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result || ''));
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/** Busca uma imagem externa e a converte para Data URL para uso em PDFs */
export async function fetchImageAsDataUrl(url: string): Promise<string | null> {
  if (!url) return null;
  if (url.startsWith('data:')) return url;
  if (!/^https?:\/\//i.test(url)) return null;

  try {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) return null;
    const blob = await response.blob();
    return await blobToDataUrl(blob);
  } catch {
    logger.warn('[PDF] Erro ao buscar imagem para o documento.');
    return null;
  }
}

export function base64ToPdfBlob(base64: string): Blob {
  const byteCharacters = atob(base64);
  const byteNumbers = new Array(byteCharacters.length);

  for (let index = 0; index < byteCharacters.length; index += 1) {
    byteNumbers[index] = byteCharacters.charCodeAt(index);
  }

  return new Blob([new Uint8Array(byteNumbers)], {
    type: 'application/pdf',
  });
}

export function base64ToPdfFile(base64: string, filename: string): File {
  return new File([base64ToPdfBlob(base64)], filename, {
    type: 'application/pdf',
  });
}
