import { act, render, screen } from '@testing-library/react';
import { signaturesService, type Signature } from '@/services/signaturesService';
import { resolveSafeSignatureImageUrl, SignaturesPanel } from './SignaturesPanel';

jest.mock('@/services/signaturesService', () => ({
  signaturesService: {
    findByDocument: jest.fn(),
  },
}));

const findByDocument = jest.mocked(signaturesService.findByDocument);

describe('resolveSafeSignatureImageUrl', () => {
  it('bloqueia esquemas executáveis e SVG data URI', () => {
    expect(resolveSafeSignatureImageUrl('javascript:alert(1)')).toBeNull();
    expect(resolveSafeSignatureImageUrl('data:image/svg+xml,<svg/>')).toBeNull();
  });

  it('preserva imagem de assinatura em formato permitido', () => {
    expect(resolveSafeSignatureImageUrl('data:image/png;base64,AAAA')).toBe(
      'data:image/png;base64,AAAA',
    );
  });
});

describe('SignaturesPanel loading', () => {
  beforeEach(() => {
    findByDocument.mockReset();
  });

  it('descarta resposta de assinatura da documentação anterior', async () => {
    let resolvePrevious!: (value: Signature[]) => void;
    let resolveCurrent!: (value: Signature[]) => void;
    const previous = new Promise<Signature[]>((resolve) => {
      resolvePrevious = resolve;
    });
    const current = new Promise<Signature[]>((resolve) => {
      resolveCurrent = resolve;
    });
    findByDocument.mockReturnValueOnce(previous).mockReturnValueOnce(current);

    const { rerender } = render(
      <SignaturesPanel
        isOpen
        onClose={jest.fn()}
        documentId="document-a"
        documentType="APR"
      />,
    );
    rerender(
      <SignaturesPanel
        isOpen
        onClose={jest.fn()}
        documentId="document-b"
        documentType="APR"
      />,
    );

    await act(async () => {
      resolveCurrent([
        {
          id: 'signature-b',
          document_id: 'document-b',
          document_type: 'APR',
          signature_data: '',
          type: 'hmac',
        },
      ]);
      await Promise.resolve();
      resolvePrevious([]);
      await Promise.resolve();
    });

    expect(screen.getByText('PIN Seguro (HMAC-SHA256)')).toBeInTheDocument();
  });
});
