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

  doc.setFillColor(...backendPdfTheme.graphite);
  doc.rect(0, 0, pageWidth, 2.8, 'F');
  doc.setFillColor(...backendPdfTheme.accent);
  doc.rect(0, 2.8, pageWidth, 0.8, 'F');

  const logoW = 27;
  const logoH = 14;
  let titleX = marginX;

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
      // Mantém o documento utilizável mesmo quando a marca da empresa falha.
    }
  }

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.setTextColor(...backendPdfTheme.text);
  doc.text(options.title, titleX, 12);

  if (options.subtitle) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(...backendPdfTheme.secondary);
    doc.text(options.subtitle, titleX, 18);
  }

  if (options.metaRight?.length) {
    let rightY = 10.5;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(...backendPdfTheme.muted);
    for (const line of options.metaRight) {
      doc.text(line, pageWidth - marginX, rightY, { align: 'right' });
      rightY += 4.2;
    }
  }

  doc.setDrawColor(...backendPdfTheme.border);
  doc.setLineWidth(0.22);
  doc.line(marginX, 25, pageWidth - marginX, 25);
}

export function createBackendPdfTableTheme() {
  return {
    theme: 'grid' as const,
    styles: {
      fontSize: 8.3,
      lineColor: backendPdfTheme.border,
      lineWidth: 0.16,
      cellPadding: 2.6,
      textColor: backendPdfTheme.text,
    },
    headStyles: {
      fillColor: backendPdfTheme.surface,
      textColor: backendPdfTheme.text,
      fontStyle: 'bold' as const,
      lineColor: backendPdfTheme.borderStrong,
      lineWidth: 0.18,
    },
    alternateRowStyles: {
      fillColor: [252, 253, 254] as [number, number, number],
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
  doc.line(marginX, y + 2.3, pageWidth - marginX, y + 2.3);
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
    doc.setDrawColor(...backendPdfTheme.border);
    doc.setLineWidth(0.2);
    doc.line(marginX, pageHeight - 13, pageWidth - marginX, pageHeight - 13);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(...backendPdfTheme.muted);
    doc.text(
      options?.systemLabel || 'SGS · Segurança do Trabalho',
      marginX,
      pageHeight - 8,
    );
    if (options?.verificationCode) {
      doc.text(
        `Código ${options.verificationCode}`,
        pageWidth / 2,
        pageHeight - 8,
        { align: 'center' },
      );
    }
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
