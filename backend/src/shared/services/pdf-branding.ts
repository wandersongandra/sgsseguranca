import { jsPDF } from 'jspdf';

type PdfWithAutoTable = jsPDF & {
  lastAutoTable?: {
    finalY?: number;
  };
};

export const backendPdfTheme = {
  graphite: [16, 32, 51] as [number, number, number],
  accent: [31, 78, 121] as [number, number, number],
  marker: [31, 78, 121] as [number, number, number],
  border: [214, 220, 228] as [number, number, number],
  borderStrong: [148, 163, 184] as [number, number, number],
  surface: [247, 249, 252] as [number, number, number],
  text: [15, 23, 42] as [number, number, number],
  secondary: [51, 65, 85] as [number, number, number],
  muted: [100, 116, 139] as [number, number, number],
};

type HeaderOptions = {
  title: string;
  subtitle?: string;
  metaRight?: string[];
  marginX?: number;
  logoBase64?: string | null;
  logoFormat?: 'PNG' | 'JPEG';
};

export function drawBackendPdfHeader(doc: jsPDF, options: HeaderOptions) {
  const pageWidth = doc.internal.pageSize.getWidth();
  const marginX = options.marginX ?? 16;
  const metaW = options.metaRight?.length ? 47 : 0;
  const logoW = 27;
  const logoH = 14;
  let titleX = marginX;

  doc.setFillColor(...backendPdfTheme.graphite);
  doc.rect(0, 0, pageWidth, 2.8, 'F');
  doc.setFillColor(...backendPdfTheme.accent);
  doc.rect(0, 2.8, pageWidth, 0.8, 'F');

  if (options.logoBase64) {
    try {
      doc.addImage(
        options.logoBase64,
        options.logoFormat ?? 'PNG',
        marginX,
        7,
        logoW,
        logoH,
      );
      titleX = marginX + logoW + 5;
    } catch {
      // O documento continua válido quando a imagem da marca não puder ser renderizada.
    }
  }

  const titleWidth = Math.max(
    64,
    pageWidth - marginX - titleX - metaW - (metaW ? 7 : 0),
  );
  const titleLines = (
    doc.splitTextToSize(options.title, titleWidth) as string[]
  ).slice(0, 2);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15.2);
  doc.setTextColor(...backendPdfTheme.text);
  doc.text(titleLines, titleX, 11.5);

  const titleBottom = 11.5 + Math.max(0, titleLines.length - 1) * 5.4;
  if (options.subtitle) {
    const subtitleLines = (
      doc.splitTextToSize(options.subtitle, titleWidth) as string[]
    ).slice(0, 2);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.4);
    doc.setTextColor(...backendPdfTheme.secondary);
    doc.text(subtitleLines, titleX, titleBottom + 5.4);
  }

  if (options.metaRight?.length) {
    let rightY = 9.4;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.2);
    doc.setTextColor(...backendPdfTheme.muted);
    for (const line of options.metaRight.slice(0, 4)) {
      const wrapped = (doc.splitTextToSize(line, metaW) as string[]).slice(0, 2);
      doc.text(wrapped, pageWidth - marginX, rightY, { align: 'right' });
      rightY += wrapped.length * 3.4 + 1.1;
    }
  }

  doc.setDrawColor(...backendPdfTheme.accent);
  doc.setLineWidth(0.45);
  doc.line(marginX, 26, marginX + 28, 26);
  doc.setDrawColor(...backendPdfTheme.border);
  doc.setLineWidth(0.18);
  doc.line(marginX + 30, 26, pageWidth - marginX, 26);
}

export function createBackendPdfTableTheme() {
  return {
    theme: 'grid' as const,
    styles: {
      fontSize: 8.2,
      lineColor: backendPdfTheme.border,
      lineWidth: 0.14,
      cellPadding: 2.35,
      textColor: backendPdfTheme.text,
      valign: 'top' as const,
      overflow: 'linebreak' as const,
    },
    headStyles: {
      fillColor: backendPdfTheme.graphite,
      textColor: [255, 255, 255] as [number, number, number],
      fontStyle: 'bold' as const,
      fontSize: 7.5,
      lineColor: backendPdfTheme.graphite,
      lineWidth: 0.16,
      cellPadding: 2.2,
    },
    alternateRowStyles: {
      fillColor: [248, 250, 252] as [number, number, number],
    },
  };
}

export function drawBackendSectionTitle(
  doc: jsPDF,
  y: number,
  title: string,
  marginX = 16,
) {
  const pageWidth = doc.internal.pageSize.getWidth();

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10.8);
  doc.setTextColor(...backendPdfTheme.text);
  doc.text(title, marginX, y);

  doc.setDrawColor(...backendPdfTheme.accent);
  doc.setLineWidth(0.45);
  doc.line(marginX, y + 2.4, marginX + 28, y + 2.4);
  doc.setDrawColor(...backendPdfTheme.border);
  doc.setLineWidth(0.18);
  doc.line(marginX + 30, y + 2.4, pageWidth - marginX, y + 2.4);
}

type FooterOptions = {
  marginX?: number;
  systemLabel?: string;
  verificationCode?: string | null;
};

export function applyBackendPdfFooter(doc: jsPDF, options?: FooterOptions) {
  const marginX = options?.marginX ?? 16;
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const pages = doc.getNumberOfPages();

  for (let page = 1; page <= pages; page += 1) {
    doc.setPage(page);

    doc.setDrawColor(...backendPdfTheme.accent);
    doc.setLineWidth(0.4);
    doc.line(marginX, pageHeight - 13, marginX + 24, pageHeight - 13);
    doc.setDrawColor(...backendPdfTheme.border);
    doc.setLineWidth(0.16);
    doc.line(
      marginX + 26,
      pageHeight - 13,
      pageWidth - marginX,
      pageHeight - 13,
    );

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(6.9);
    doc.setTextColor(...backendPdfTheme.secondary);
    doc.text(
      options?.systemLabel || 'SGS · Segurança do Trabalho',
      marginX,
      pageHeight - 8,
    );

    if (options?.verificationCode) {
      doc.setFont('courier', 'normal');
      doc.setFontSize(6.5);
      doc.setTextColor(...backendPdfTheme.muted);
      doc.text(
        `ID ${options.verificationCode}`,
        pageWidth / 2,
        pageHeight - 8,
        { align: 'center' },
      );
    }

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.9);
    doc.setTextColor(...backendPdfTheme.muted);
    doc.text(
      `Página ${page} de ${pages}`,
      pageWidth - marginX,
      pageHeight - 8,
      { align: 'right' },
    );
  }
}

export function getBackendLastTableY(doc: jsPDF, fallback = 120): number {
  const pdfWithAutoTable = doc as PdfWithAutoTable;
  return typeof pdfWithAutoTable.lastAutoTable?.finalY === 'number'
    ? pdfWithAutoTable.lastAutoTable.finalY
    : fallback;
}
