export function decodeDdsSignatureToken(rawToken: string): string {
  try {
    return decodeURIComponent(rawToken);
  } catch {
    return "";
  }
}

export function resolveDdsSignatureToken(
  urlToken: string,
  sessionToken: string | null,
): string | null {
  return urlToken || sessionToken || null;
}
