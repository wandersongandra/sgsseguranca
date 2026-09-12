import { fireEvent, render, screen } from '@testing-library/react';
import { PtSignatureActions } from './PtSignatureActions';

const createSignature = jest.fn();

jest.mock('next/dynamic', () => ({
  __esModule: true,
  default: () =>
    ({
      isOpen,
      onSave,
    }: {
      isOpen: boolean;
      onSave: (data: string, type: string) => void;
    }) =>
      isOpen ? (
        <button type="button" onClick={() => onSave('signature', 'drawn')}>
          Confirmar assinatura
        </button>
      ) : null,
}));

jest.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'user-1', nome: 'Usuário' },
    hasPermission: () => true,
  }),
}));

jest.mock('@/services/ptsService', () => ({
  ptsService: {
    createSignature: (...args: unknown[]) => createSignature(...args),
  },
}));

jest.mock('@/components/SignaturesPanel', () => ({
  SignaturesPanel: () => null,
}));

describe('PtSignatureActions', () => {
  it('ignora duplo submit da assinatura enquanto a primeira request está pendente', async () => {
    let resolveCreate!: () => void;
    createSignature.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveCreate = resolve;
      }),
    );

    render(
      <PtSignatureActions
        ptId="pt-1"
        onSignatureSaved={jest.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Assinar PT' }));
    const confirm = screen.getByRole('button', { name: 'Confirmar assinatura' });
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    expect(createSignature).toHaveBeenCalledTimes(1);
    resolveCreate();
  });
});
