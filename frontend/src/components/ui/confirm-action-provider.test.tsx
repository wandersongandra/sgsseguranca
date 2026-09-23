import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { ConfirmActionProvider, useConfirmAction } from './confirm-action-provider';

function ConfirmationHarness() {
  const { confirmAction } = useConfirmAction();
  const [result, setResult] = useState('pending');

  return (
    <>
      <button
        type="button"
        onClick={() => {
          void confirmAction({
            title: 'Excluir item',
            description: 'Esta ação não pode ser desfeita.',
            confirmLabel: 'Excluir',
          }).then((confirmed) => setResult(confirmed ? 'confirmed' : 'cancelled'));
        }}
      >
        Remover
      </button>
      <output>{result}</output>
    </>
  );
}

describe('ConfirmActionProvider', () => {
  it('apresenta o ConfirmModal e resolve a ação confirmada', async () => {
    render(
      <ConfirmActionProvider>
        <ConfirmationHarness />
      </ConfirmActionProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remover' }));

    expect(
      await screen.findByRole('dialog', { name: 'Excluir item' }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Excluir' }));

    await waitFor(() => {
      expect(screen.getByText('confirmed')).toBeInTheDocument();
    });
  });
});
