import { drawRiskSummaryPanel } from "./RiskSummaryPanel";
import { baseTone, spacing, typography } from "../tokens/visualTokens";
import type { PdfContext } from "../core/types";

function createMockContext(): {
  ctx: PdfContext;
  doc: {
    splitTextToSize: jest.Mock;
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
  };
} {
  const doc = {
    splitTextToSize: jest.fn((value: string) =>
      String(value).includes("prioritaria")
        ? [
            "Medida prioritaria muito longa",
            "que precisa quebrar",
            "em varias linhas para",
            "nao sair da folha",
          ]
        : [String(value)],
    ),
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
  };

  return {
    doc,
    ctx: {
      doc: doc as unknown as PdfContext["doc"],
      pageWidth: 210,
      pageHeight: 297,
      margin: 16,
      contentWidth: 178,
      y: 238,
      theme: {
        variant: "critical",
        tone: baseTone,
        typography,
        spacing,
      },
    },
  };
}

describe("drawRiskSummaryPanel", () => {
  it("aumenta a altura do painel e quebra pagina quando a medida prioritaria cresce", () => {
    const { ctx, doc } = createMockContext();

    drawRiskSummaryPanel(ctx, {
      severity: "Alta",
      probability: "Provavel",
      status: "Aprovada",
      priorityAction:
        "Medida prioritaria muito longa que precisa quebrar em varias linhas para nao sair da folha",
    });

    expect(doc.addPage).toHaveBeenCalled();
    expect(doc.rect).toHaveBeenCalledWith(
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      "FD",
    );

    const panelHeight = (doc.rect.mock.calls[0] || [])[3] as number;
    expect(panelHeight).toBeGreaterThan(26);
    expect(ctx.y).toBeGreaterThan(22);
  });
});
