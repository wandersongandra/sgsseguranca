import type { PdfContext } from "./types";
import { formatDateTime, sanitize } from "./format";

interface JsPdfWithGState {
  GState?: new (opts: { opacity: number }) => { opacity: number };
}

const DRAFT_DISCLAIMER_LINES = [
  "RASCUNHO — NÃO É DOCUMENTO OFICIAL",
  "O PDF final oficial é gerado somente pelo backend do SGS.",
];

/**
 * Aplica marca d'água "RASCUNHO" diagonal e rodapé de aviso em todas as páginas.
 *
 * Deve ser chamado apenas em PDFs gerados pelo frontend (previews/rascunhos).
 * PDFs oficiais são gerados exclusivamente pelo backend e registrados no DocumentRegistry —
 * nunca passam por esta função.
 */
export function applyDraftWatermark(ctx: PdfContext) {
  const { doc, pageWidth, pageHeight } = ctx;
  const pages = doc.getNumberOfPages();
  const GStateClass = (doc as unknown as JsPdfWithGState).GState;

  for (let page = 1; page <= pages; page++) {
    doc.setPage(page);

    // ── Marca d'água diagonal ────────────────────────────────────────────────
    doc.setFont("helvetica", "bold");
    doc.setFontSize(90);
    doc.setTextColor(150, 150, 150);
    if (GStateClass) {
      doc.setGState(new GStateClass({ opacity: 0.15 }));
    }
    doc.text(
      "RASCUNHO — NÃO É DOCUMENTO OFICIAL",
      pageWidth / 2,
      pageHeight / 2,
      {
        align: "center",
        angle: 45,
      },
    );
    if (GStateClass) {
      doc.setGState(new GStateClass({ opacity: 1 }));
    }

    // ── Rodapé de aviso (abaixo do footer de governança) ────────────────────
    doc.setFont("helvetica", "italic");
    doc.setFontSize(6);
    doc.setTextColor(120, 120, 120);
    doc.text(DRAFT_DISCLAIMER_LINES, pageWidth / 2, pageHeight - 1.5, {
      align: "center",
    });
  }
}

export function applyDocumentFooter(
  ctx: PdfContext,
  options: {
    code: string;
    generatedAt?: string;
    issuer?: string;
    draft?: boolean;
  },
) {
  const pages = ctx.doc.getNumberOfPages();
  const generatedAt =
    options.generatedAt || formatDateTime(new Date().toISOString());
  const issuer = sanitize(
    options.issuer || "SGS — Sistema de Gestão de Segurança",
  );

  for (let page = 1; page <= pages; page++) {
    ctx.doc.setPage(page);
    ctx.doc.setDrawColor(...ctx.theme.tone.brand);
    ctx.doc.setLineWidth(0.4);
    ctx.doc.line(ctx.margin, 283.5, ctx.margin + 24, 283.5);
    ctx.doc.setDrawColor(...ctx.theme.tone.border);
    ctx.doc.setLineWidth(0.16);
    ctx.doc.line(
      ctx.margin + 26,
      283.5,
      ctx.pageWidth - ctx.margin,
      283.5,
    );

    ctx.doc.setFont("helvetica", "bold");
    ctx.doc.setFontSize(ctx.theme.typography.caption);
    ctx.doc.setTextColor(...ctx.theme.tone.textSecondary);
    ctx.doc.text(issuer, ctx.margin, 288.7);

    ctx.doc.setFont("courier", "normal");
    ctx.doc.setFontSize(Math.max(5.8, ctx.theme.typography.caption - 0.4));
    ctx.doc.setTextColor(...ctx.theme.tone.textMuted);
    ctx.doc.text(
      `ID ${options.code}`,
      ctx.pageWidth / 2,
      288.7,
      { align: "center" },
    );

    ctx.doc.setFont("helvetica", "normal");
    ctx.doc.setFontSize(ctx.theme.typography.caption);
    ctx.doc.setTextColor(...ctx.theme.tone.textMuted);
    ctx.doc.text(
      `Página ${page} de ${pages}`,
      ctx.pageWidth - ctx.margin,
      288.7,
      { align: "right" },
    );

    ctx.doc.text(`Gerado em ${generatedAt}`, ctx.margin, 292.7);
    ctx.doc.text(
      options.draft === true ? "Prévia — documento não oficial" : "Documento eletrônico SGS",
      ctx.pageWidth - ctx.margin,
      292.7,
      { align: "right" },
    );
  }

  // Aplica marca d'água e aviso de prévia apenas para PDFs explicitamente em
  // modo rascunho. Usar `=== true` (e não `!== false`) evita que um futuro
  // chamador que omita o flag marque um documento oficial como rascunho.
  if (options.draft === true) {
    applyDraftWatermark(ctx);
  }
}
