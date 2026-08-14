import {
  getNcAttachmentReferencesForSave,
  isCurrentNcAttachmentContext,
  toNcAttachmentFormValues,
} from './NonConformityForm';

const GOVERNED_ATTACHMENT_REFERENCE =
  'gst:nc-attachment:eyJ2IjoxLCJraW5kIjoiZ292ZXJuZWQtc3RvcmFnZSIsImZpbGVLZXkiOiJkb2N1bWVudHMvY29tcGFueS0xL25jL2V2aWRlbmNpYS5qcGciLCJvcmlnaW5hbE5hbWUiOiJldmlkZW5jaWEuanBnIiwibWltZVR5cGUiOiJpbWFnZS9qcGVnIiwidXBsb2FkZWRBdCI6IjIwMjYtMDgtMDNUMTM6MDA6MDAuMDAwWiJ9';

describe('NonConformityForm attachment safeguards', () => {
  it('preserva anexos legados carregados e descarta URLs que não vieram da API', () => {
    const legacyAttachment = 'https://legacy.example.com/evidencia-antiga.pdf';
    const attachments = toNcAttachmentFormValues([
      legacyAttachment,
      GOVERNED_ATTACHMENT_REFERENCE,
      'https://not-authorized.example.com/manual.pdf',
    ]);

    expect(
      getNcAttachmentReferencesForSave(
        attachments,
        new Set([legacyAttachment]),
      ),
    ).toEqual([legacyAttachment, GOVERNED_ATTACHMENT_REFERENCE]);
  });

  it('não aplica o resultado de upload que terminou após a troca de tenant', () => {
    expect(
      isCurrentNcAttachmentContext(
        {
          tenantGeneration: 3,
          companyId: 'company-a',
          nonConformityId: 'nc-1',
        },
        {
          tenantGeneration: 4,
          companyId: 'company-b',
          nonConformityId: 'nc-1',
        },
      ),
    ).toBe(false);
  });
});
