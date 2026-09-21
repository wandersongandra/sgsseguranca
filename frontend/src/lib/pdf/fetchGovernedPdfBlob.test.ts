const apiGetMock = jest.fn();
jest.mock("@/lib/api", () => ({
  __esModule: true,
  default: { get: (...args: unknown[]) => apiGetMock(...args) },
}));

import { fetchGovernedPdfBlob } from "./fetchGovernedPdfBlob";

describe("fetchGovernedPdfBlob", () => {
  const originalApiUrl = process.env.NEXT_PUBLIC_API_URL;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NEXT_PUBLIC_API_URL = "https://api.sgsseguranca.com.br";
  });

  afterAll(() => {
    process.env.NEXT_PUBLIC_API_URL = originalApiUrl;
  });

  it("busca o PDF com o client autenticado (não window.open cru) para não perder o Bearer token", async () => {
    // Achado real da auditoria v2, confirmado ao vivo em produção: o backend
    // (document-download-grant.service.ts::consumeToken) exige o Bearer
    // token na própria requisição que consome o link assinado de download,
    // amarrando o consumo ao usuário emissor. window.open() numa URL crua
    // nunca envia esse header — o token era sempre rejeitado ("Token de
    // download inválido, expirado ou já consumido."), mesmo na primeira
    // tentativa. Buscar com `api` (que injeta o Bearer automaticamente)
    // resolve isso.
    const blob = new Blob(["%PDF-1.4"], { type: "application/pdf" });
    apiGetMock.mockResolvedValueOnce({
      data: blob,
      headers: { "content-disposition": 'attachment; filename="apr.pdf"' },
    });

    const result = await fetchGovernedPdfBlob(
      "https://api.sgsseguranca.com.br/storage/download/token123",
    );

    expect(apiGetMock).toHaveBeenCalledWith(
      "https://api.sgsseguranca.com.br/storage/download/token123",
      { responseType: "blob" },
    );
    expect(result.blob).toBe(blob);
    expect(result.filename).toBe("apr.pdf");
  });

  it("retorna filename null quando o header content-disposition não está presente", async () => {
    const blob = new Blob(["%PDF-1.4"], { type: "application/pdf" });
    apiGetMock.mockResolvedValueOnce({ data: blob, headers: {} });

    const result = await fetchGovernedPdfBlob(
      "https://api.sgsseguranca.com.br/storage/download/token123",
    );

    expect(result.filename).toBeNull();
  });
});
