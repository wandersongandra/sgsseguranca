import { drawDocumentHeader } from "./DocumentHeader";
import { baseTone, spacing, typography } from "../tokens/visualTokens";
import type { PdfContext } from "../core/types";

function createMockContext(): {
  ctx: PdfContext;
  doc: {
    splitTextToSize: jest.Mock;
    getCurrentPageInfo: jest.Mock;
    setFillColor: jest.Mock;
    setDrawColor: jest.Mock;
    setLineWidth: jest.Mock;
    roundedRect: jest.Mock;
    rect: jest.Mock;
    setFont: jest.Mock;
    setFontSize: jest.Mock;
    setTextColor: jest.Mock;
    text: jest.Mock;
  };
} {
  const doc = {
    splitTextToSize: jest.fn((value: string) => [String(value)]),
    getCurrentPageInfo: jest.fn(() => ({ pageNumber: 1 })),
    setFillColor: jest.fn(),
    setDrawColor: jest.fn(),
    setLineWidth: jest.fn(),
    roundedRect: jest.fn(),
    rect: jest.fn(),
    setFont: jest.fn(),
    setFontSize: jest.fn(),
    setTextColor: jest.fn(),
    text: jest.fn(),
  };

  return {
    doc,
    ctx: {
      doc: doc as unknown as PdfContext["doc"],
      pageWidth: 210,
      pageHeight: 297,
      margin: 16,
      contentWidth: 178,
      y: 16,
      theme: {
        variant: "compliance",
        tone: baseTone,
        typography,
        spacing,
      },
    },
  };
}

describe("drawDocumentHeader", () => {
  it("posiciona o conteudo logo abaixo do cabecalho sem somar a margem duas vezes", () => {
    const { ctx } = createMockContext();

    drawDocumentHeader(ctx, {
      title: "RELATORIO DE AUDITORIA",
      subtitle: "Documento oficial de conformidade",
      code: "AUD-2026-12345678",
      date: "2026-07-06",
      status: "Emitido",
      version: "1",
      company: "Empresa Demo",
      site: "Unidade Norte",
    });

    expect(ctx.y).toBeGreaterThan(48);
    expect(ctx.y).toBeLessThan(54);
  });

  it("usa cabecalho compacto nas paginas seguintes quando compactOnRepeat=true", () => {
    const { ctx, doc } = createMockContext();
    doc.getCurrentPageInfo.mockReturnValue({ pageNumber: 2 });

    drawDocumentHeader(ctx, {
      title: "PERMISSAO DE TRABALHO",
      subtitle: "Documento oficial de liberacao operacional em SST",
      code: "PT-2026-001",
      codeLabel: "Numero da PT",
      date: "10/07/2026 08:00",
      status: "Pendente",
      company: "Empresa Demo",
      site: "Obra Norte",
      compactOnRepeat: true,
    });

    expect(ctx.y).toBeGreaterThan(22);
    expect(ctx.y).toBeLessThan(28);
  });
});
