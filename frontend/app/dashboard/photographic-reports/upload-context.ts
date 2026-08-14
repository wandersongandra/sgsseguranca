import type { PendingPhoto, UploadGeoContext } from './types';

/**
 * Contexto de captura do lote de fotos.
 *
 * Duas restrições reais moldam este arquivo:
 *
 * 1. `processMobileImage` re-encoda a imagem via `canvas.toBlob()` antes do
 *    upload, o que DESTRÓI o EXIF. Ler `DateTimeOriginal` do arquivo enviado é
 *    impossível — a data de captura precisa sair de `File.lastModified`, que
 *    sobrevive ao processamento e, em câmera de celular, é a hora da foto.
 *
 * 2. A geolocalização é do OPERADOR no momento do envio, não de cada foto.
 *    Uma posição por lote é o que o navegador consegue oferecer, e prometer
 *    mais do que isso no documento seria falso.
 */

/**
 * Posição atual, quando o navegador permite.
 *
 * Nunca lança e nunca bloqueia: o upload precisa acontecer mesmo sem
 * geolocalização, e a ausência é registrada como `denied` para que a interface
 * consiga avisar o usuário de que a evidência ficou mais fraca.
 */
export async function captureUploadGeoContext(): Promise<UploadGeoContext> {
  // Fora de contexto seguro a API não existe — e em alguns navegadores o
  // acesso lança em vez de chamar o callback de erro.
  if (
    typeof navigator === 'undefined' ||
    !('geolocation' in navigator) ||
    typeof window === 'undefined' ||
    !window.isSecureContext
  ) {
    return { denied: true };
  }

  try {
    const position = await new Promise<GeolocationPosition>(
      (resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 8000,
          maximumAge: 60000,
        });
      },
    );

    return {
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      accuracy_m: position.coords.accuracy,
    };
  } catch {
    // Permissão negada, timeout ou indisponível — todos levam ao mesmo lugar.
    return { denied: true };
  }
}

/**
 * Datas de captura alinhadas por índice com os arquivos que serão enviados.
 *
 * O contrato posicional é o mesmo que o backend espera: o índice N descreve o
 * arquivo N. Só entram fotos prontas, na mesma ordem em que os arquivos são
 * montados pelo chamador.
 */
export function buildCapturedAtList(pendingPhotos: PendingPhoto[]): string[] {
  return pendingPhotos
    .filter((photo) => photo.status === 'ready' && photo.processed)
    .map((photo) => {
      if (photo.capturedAt) return photo.capturedAt;
      const lastModified = photo.original?.lastModified;
      return lastModified
        ? new Date(lastModified).toISOString()
        : new Date().toISOString();
    });
}
