import type { Training } from '@/services/trainingsService';
import type { Signature } from '@/services/signaturesService';
import { pdfDocToBase64, type PdfOutputDoc } from './pdfBase64';
import { resolveCompanyLogoDataUrl } from "./companyLogo";
import { resolveValidationContext } from "./validationContext";
import {
  applyFooterGovernance,
  applyInstitutionalDocumentHeader,
  buildDocumentCode,
  buildPdfFilename,
  buildValidationUrl,
  createPdfContext,
  drawTrainingBlueprint,
  formatDate,
  formatDateTime,
  sanitize,
} from '@/lib/pdf-system';

type PdfOptions = {
  save?: boolean;
  output?: 'base64';
  draftWatermark?: boolean;
};

function resolveTrainingHeaderStatus(training: Training) {
  if (!training.data_vencimento) return "Válido";

  const expiryDate = new Date(training.data_vencimento);
  if (Number.isNaN(expiryDate.getTime())) return "Válido";

  const remainingDays = Math.ceil(
    (expiryDate.getTime() - Date.now()) / 86400000,
  );

  if (remainingDays < 0) return "Vencido";
  if (remainingDays <= 30) return `Vence em ${remainingDays} dias`;
  return "Válido";
}

export async function generateTrainingPdf(
  training: Training,
  signatures: Signature[],
  options?: PdfOptions,
): Promise<void | { base64: string; filename: string }> {
  const { jsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');

  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const ctx = createPdfContext(doc, 'training');
  const validationContext = await resolveValidationContext(
    'trainings',
    training.id,
  );
  const code =
    validationContext.documentCode ||
    buildDocumentCode('TRN', training.id || training.nr_codigo || training.nome);

  // Fetch company logo if available
  const logoUrl = await resolveCompanyLogoDataUrl(training.company);

  ctx.y = applyInstitutionalDocumentHeader(ctx, {
    title: "COMPROVANTE DE TREINAMENTO",
    subtitle: "Registro de capacitação, validade e requisitos aplicáveis",
    code,
    date: formatDate(training.data_conclusao),
    status: resolveTrainingHeaderStatus(training),
    version: "1",
    company: sanitize(training.company?.razao_social || training.company_id),
    site: "-",
    logoUrl,
  });
  await drawTrainingBlueprint(
    ctx,
    autoTable,
    training,
    signatures,
    code,
    buildValidationUrl(code, validationContext.token),
  );
  applyFooterGovernance(ctx, {
    code,
    generatedAt: formatDateTime(new Date().toISOString()),
    draft: options?.draftWatermark ?? false,
  });

  const filename = buildPdfFilename('TREINAMENTO', `${training.nome}_${training.user?.nome ?? 'colaborador'}`, training.data_conclusao);
  if (options?.save === false && options?.output === 'base64') {
    const docOutput = doc as unknown as PdfOutputDoc;
    return { base64: pdfDocToBase64(docOutput), filename };
  }
  doc.save(filename);
}
