import { render, screen } from '@testing-library/react';
import { PtClosureModal } from './PtClosureModal';

describe('PtClosureModal', () => {
  it('expõe diálogo modal e associa os rótulos aos campos', () => {
    render(
      <PtClosureModal
        pt={
          {
            id: 'pt-1',
            numero: 'PT-001',
            data_hora_inicio: '2026-07-01T08:00:00.000Z',
          } as never
        }
        loading={false}
        onClose={jest.fn()}
        onConfirm={jest.fn()}
      />,
    );

    expect(screen.getByRole('dialog', { name: 'Encerrar PT PT-001' })).toBeInTheDocument();
    expect(screen.getByLabelText(/Condição da área/)).toBeInTheDocument();
    expect(screen.getByLabelText('Data/hora real de término')).toBeInTheDocument();
    expect(screen.getByLabelText('Observações de encerramento')).toBeInTheDocument();
  });
});
