import { fireEvent, render, screen } from '@testing-library/react';
import { PtRejectModal } from './PtRejectModal';

describe('PtRejectModal', () => {
  it('exige motivo e envia o valor normalizado', () => {
    const onConfirm = jest.fn();
    render(<PtRejectModal isOpen loading={false} onClose={jest.fn()} onConfirm={onConfirm} />);

    const confirm = screen.getByRole('button', { name: 'Confirmar reprovação' });
    expect(confirm).toBeDisabled();

    const reason = screen.getByRole('textbox', { name: 'Motivo da reprovação' });
    expect(reason).toHaveAttribute('maxLength', '2000');
    fireEvent.blur(reason);
    expect(screen.getByRole('alert')).toHaveTextContent('obrigatório');

    fireEvent.change(reason, { target: { value: '  Falta evidência obrigatória  ' } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith('Falta evidência obrigatória');
  });
});
