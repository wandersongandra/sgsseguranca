import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PtsTableRow } from './PtsTableRow';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

jest.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: {
      id: 'user-1',
      nome: 'Tecnico',
    },
    hasPermission: () => true,
  }),
}));

jest.mock('@/components/SignatureModal', () => ({
  SignatureModal: ({
    isOpen,
    onSave,
  }: {
    isOpen: boolean;
    onSave: (signatureData: string, type: string) => void;
  }) =>
    isOpen ? (
      <button type="button" onClick={() => onSave('signature-data', 'draw')}>
        Salvar assinatura
      </button>
    ) : null,
}));

jest.mock('@/components/SignaturesPanel', () => ({
  SignaturesPanel: () => null,
}));

const createSignature = jest.fn();
const onDismissApprovalIssue = jest.fn();
const onDismissApprovalReview = jest.fn();

jest.mock('@/services/ptsService', () => ({
  ptsService: {
    createSignature: (...args: unknown[]) => createSignature(...args),
  },
}));

describe('PtsTableRow', () => {
  beforeEach(() => {
    createSignature.mockResolvedValue(undefined);
    onDismissApprovalIssue.mockClear();
    onDismissApprovalReview.mockClear();
  });

  it('registra a assinatura e limpa eventual bloqueio sem perder o checklist', async () => {
    const pt = {
      id: 'pt-1',
      numero: 'PT-001',
      titulo: 'PT de teste',
      data_hora_inicio: '2026-07-01T08:00:00.000Z',
      data_hora_fim: '2026-07-01T10:00:00.000Z',
      status: 'Pendente',
      company_id: 'company-1',
    };

    render(
      <table>
        <tbody>
          <PtsTableRow
            pt={pt as never}
            onDelete={jest.fn()}
            onPrint={jest.fn()}
            onSendEmail={jest.fn()}
            onDownloadPdf={jest.fn()}
            onPrepareApproval={jest.fn()}
            onApprove={jest.fn()}
            onReject={jest.fn()}
            onFinalize={jest.fn()}
            approvingId={null}
            rejectingId={null}
            finalizingId={null}
            approvalReviewLoadingId={null}
            approvalIssue={undefined}
            approvalReview={undefined}
            approvalChecklist={{
              reviewedReadiness: false,
              reviewedWorkers: false,
              confirmedRelease: false,
            }}
            onDismissApprovalIssue={onDismissApprovalIssue}
            onDismissApprovalReview={onDismissApprovalReview}
            onUpdateApprovalChecklist={jest.fn()}
          />
        </tbody>
      </table>,
    );

    fireEvent.click(screen.getByTitle('Assinar PT'));

    fireEvent.click(await screen.findByRole('button', { name: 'Salvar assinatura' }));

    await waitFor(() => {
      expect(createSignature).toHaveBeenCalledWith('pt-1', {
        signature_data: 'signature-data',
        type: 'draw',
      });
      expect(onDismissApprovalReview).not.toHaveBeenCalled();
      expect(onDismissApprovalIssue).toHaveBeenCalledWith('pt-1');
    });
  });

  it('expõe nome acessível para o botão de emissão do PDF governado', () => {
    const pt = {
      id: 'pt-1',
      numero: 'PT-001',
      titulo: 'PT aprovada',
      data_hora_inicio: '2026-07-01T08:00:00.000Z',
      data_hora_fim: '2026-07-01T10:00:00.000Z',
      status: 'Aprovada',
      company_id: 'company-1',
      pdf_file_key: null,
    };

    render(
      <table>
        <tbody>
          <PtsTableRow
            pt={pt as never}
            onDelete={jest.fn()}
            onPrint={jest.fn()}
            onSendEmail={jest.fn()}
            onDownloadPdf={jest.fn()}
            onPrepareApproval={jest.fn()}
            onApprove={jest.fn()}
            onReject={jest.fn()}
            onFinalize={jest.fn()}
            approvingId={null}
            rejectingId={null}
            finalizingId={null}
            approvalReviewLoadingId={null}
            approvalChecklist={{
              reviewedReadiness: false,
              reviewedWorkers: false,
              confirmedRelease: false,
            }}
            onDismissApprovalIssue={jest.fn()}
            onDismissApprovalReview={jest.fn()}
            onUpdateApprovalChecklist={jest.fn()}
            onEmitGovernedPdf={jest.fn()}
            emittingPdfId={null}
          />
        </tbody>
      </table>,
    );

    const emitButton = screen.getByRole('button', {
      name: 'Emitir PDF final governado',
    });
    expect(emitButton).toHaveAttribute('aria-label', 'Emitir PDF final governado');
  });

  it('não deixa o link de edição de PT finalizada ativável por teclado', () => {
    const pt = {
      id: 'pt-1',
      numero: 'PT-001',
      titulo: 'PT encerrada',
      data_hora_inicio: '2026-07-01T08:00:00.000Z',
      data_hora_fim: '2026-07-01T10:00:00.000Z',
      status: 'Encerrada',
      company_id: 'company-1',
      pdf_file_key: null,
    };

    render(
      <table>
        <tbody>
          <PtsTableRow
            pt={pt as never}
            onDelete={jest.fn()}
            onPrint={jest.fn()}
            onSendEmail={jest.fn()}
            onDownloadPdf={jest.fn()}
            onPrepareApproval={jest.fn()}
            onApprove={jest.fn()}
            onReject={jest.fn()}
            onFinalize={jest.fn()}
            approvingId={null}
            rejectingId={null}
            finalizingId={null}
            approvalReviewLoadingId={null}
            approvalChecklist={{
              reviewedReadiness: false,
              reviewedWorkers: false,
              confirmedRelease: false,
            }}
            onDismissApprovalIssue={jest.fn()}
            onDismissApprovalReview={jest.fn()}
            onUpdateApprovalChecklist={jest.fn()}
          />
        </tbody>
      </table>,
    );

    expect(
      screen.getByRole('button', {
        name: 'Somente PTs pendentes podem ser editadas',
      }),
    ).toBeDisabled();
    expect(screen.queryByRole('link', { name: 'Editar PT' })).not.toBeInTheDocument();
  });
});
