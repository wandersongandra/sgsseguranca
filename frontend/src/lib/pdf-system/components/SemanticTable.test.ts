import { drawSemanticTable } from "./SemanticTable";
import { baseTone, spacing, typography } from "../tokens/visualTokens";
import type { AutoTableFn, PdfContext } from "../core/types";

function createMockContext(): {
  ctx: PdfContext;
  doc: {
    addPage: jest.Mock;
    setFillColor: jest.Mock;
    setDrawColor: jest.Mock;
    setLineWidth: jest.Mock;
    roundedRect: jest.Mock;
    rect: jest.Mock;
    setFont: jest.Mock;
    setFontSize: jest.Mock;
    setTextColor: jest.Mock;
    text: jest.Mock;
    line: jest.Mock;
    lastAutoTable?: { finalY?: number };
  };
  autoTable: jest.Mock;
} {
  const doc = {
    addPage: jest.fn(),
    setFillColor: jest.fn(),
    setDrawColor: jest.fn(),
    setLineWidth: jest.fn(),
    roundedRect: jest.fn(),
    rect: jest.fn(),
    setFont: jest.fn(),
    setFontSize: jest.fn(),
    setTextColor: jest.fn(),
    text: jest.fn(),
    line: jest.fn(),
    lastAutoTable: undefined as { finalY?: number } | undefined,
  };

  const autoTable = jest.fn((targetDoc: typeof doc, options: { startY?: number }) => {
    targetDoc.lastAutoTable = { finalY: (options.startY || 0) + 18 };
  });

  return {
    doc,
    autoTable,
    ctx: {
      doc: doc as unknown as PdfContext["doc"],
      pageWidth: 210,
      pageHeight: 297,
      margin: 16,
      contentWidth: 178,
      y: 252,
      theme: {
        variant: "operational",
        tone: baseTone,
        typography,
        spacing,
      },
    },
  };
}

describe("drawSemanticTable", () => {
  it("abre nova pagina antes do titulo quando nao ha espaco para cabecalho e primeira linha", () => {
    const { ctx, doc, autoTable } = createMockContext();

    drawSemanticTable(ctx, {
      title: "Tabela critica",
      head: [["Coluna A", "Status"]],
      body: [["Texto importante", "Conforme"]],
      autoTable: autoTable as unknown as AutoTableFn,
    });

    expect(doc.addPage).toHaveBeenCalled();
    expect(autoTable).toHaveBeenCalled();
    expect(ctx.y).toBeGreaterThanOrEqual(22);
  });

  it("aplica quebra suave em tokens longos para evitar texto vazando da celula", () => {
    const { ctx, autoTable } = createMockContext();
    const veryLongToken =
      "SEMESPACO1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZTOKENFINAL";

    drawSemanticTable(ctx, {
      title: "Tabela de risco",
      head: [["Controle"]],
      body: [[veryLongToken]],
      autoTable: autoTable as unknown as AutoTableFn,
    });

    const options = autoTable.mock.calls[0]?.[1] as {
      body?: Array<Array<string | number>>;
    };
    const firstCell = String(options.body?.[0]?.[0] || "");

    expect(firstCell).toContain(" ");
  });

  it("repete o titulo com sufixo de continuacao em pagina adicional da tabela", () => {
    const { ctx, doc } = createMockContext();
    const autoTable = jest.fn(
      (
        targetDoc: typeof doc,
        options: {
          willDrawPage?: (data: { pageNumber?: number }) => void;
          startY?: number;
        },
      ) => {
        options.willDrawPage?.({ pageNumber: 2 });
        targetDoc.lastAutoTable = { finalY: (options.startY || 0) + 18 };
      },
    );

    drawSemanticTable(ctx, {
      title: "Tabela de risco",
      head: [["Controle"]],
      body: [["Texto"]],
      autoTable: autoTable as unknown as AutoTableFn,
    });

    expect(doc.text).toHaveBeenCalledWith(
      "Tabela de risco (continuação)",
      expect.any(Number),
      expect.any(Number),
    );
  });
});
