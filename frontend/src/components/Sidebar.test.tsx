import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { Sidebar } from './Sidebar';

const usePathname = jest.fn();
const useAuth = jest.fn();
let desktop = true;
let mediaListener: (() => void) | undefined;

jest.mock('next/navigation', () => ({
  usePathname: () => usePathname(),
}));

jest.mock('@/context/AuthContext', () => ({
  useAuth: () => useAuth(),
}));

describe('Sidebar', () => {
  beforeEach(() => {
    usePathname.mockReturnValue('/dashboard/tst');
    desktop = true;
    mediaListener = undefined;
    window.matchMedia = jest.fn().mockImplementation(() => ({
      get matches() { return desktop; },
      media: '(min-width: 1280px)',
      onchange: null,
      addEventListener: (_event: string, listener: () => void) => { mediaListener = listener; },
      removeEventListener: jest.fn(),
      addListener: jest.fn(),
      removeListener: jest.fn(),
      dispatchEvent: jest.fn(),
    }));
  });

  it('shows operational navigation and user management for TST users without admin-only links', () => {
    useAuth.mockReturnValue({
      logout: jest.fn(),
      user: {
        nome: 'Tecnico',
        profile: { nome: 'Técnico de Segurança' },
      },
      roles: ['Técnico de Segurança'],
      isAdminGeral: false,
      hasPermission: () => true,
    });

    render(<Sidebar />);

    expect(screen.getByText('Início')).toBeInTheDocument();
    expect(screen.getByText('Campo e Operação')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /DDS/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /PTs/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^Empresas$/i })).not.toBeInTheDocument();

    // Seção 'Empresa' (ex-Estrutura) inicia recolhida por padrão (#252):
    // os itens só aparecem ao expandir.
    expect(
      screen.queryByRole('link', { name: /Funcionários/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: /Usuários e acesso/i }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Empresa$/i }));
    expect(
      screen.getByRole('link', { name: /Funcionários/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Usuários e acesso/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Calendário/i })).toBeInTheDocument();
  });

  it('shows administrative links for admin users', () => {
    usePathname.mockReturnValue('/dashboard/companies');
    useAuth.mockReturnValue({
      logout: jest.fn(),
      user: {
        nome: 'Admin',
        profile: { nome: 'Administrador Geral' },
      },
      roles: ['Administrador Geral'],
      isAdminGeral: true,
      hasPermission: () => true,
    });

    render(<Sidebar />);

    expect(screen.getByText('Início')).toBeInTheDocument();

    // Rota ativa (/dashboard/companies) expande automaticamente a seção 'Empresa'.
    const empresaSection = screen.getByText('Empresa').closest('section');
    expect(empresaSection).toBeTruthy();
    expect(
      within(empresaSection as HTMLElement).getByRole('link', {
        name: /^Empresas$/i,
      }),
    ).toBeInTheDocument();
    expect(
      within(empresaSection as HTMLElement).getByRole('link', {
        name: /Usuários e acesso/i,
      }),
    ).toBeInTheDocument();

    // 'Conformidade' (ex-Leitura e Gestão) inicia recolhida; expande e valida item.
    const conformidadeToggle = screen.getByRole('button', {
      name: /^Conformidade$/i,
    });
    expect(conformidadeToggle).toBeInTheDocument();
    fireEvent.click(conformidadeToggle);
    expect(
      screen.getByRole('link', { name: /Mapa de risco/i }),
    ).toBeInTheDocument();
  });

  it('fecha com Escape, prende o foco e o restaura no gatilho', async () => {
    desktop = false;
    useAuth.mockReturnValue({
      logout: jest.fn(),
      user: { nome: 'Tecnico', profile: { nome: 'Técnico' } },
      isAdminGeral: false,
      hasPermission: () => true,
    });

    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>Abrir menu</button>
          <Sidebar isOpen={open} onClose={() => setOpen(false)} />
        </>
      );
    }

    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Abrir menu' });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Menu lateral' });
    const close = screen.getByRole('button', { name: 'Fechar navegação' });
    close.focus();
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Menu lateral' })).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('mantém o drawer mobile fechado fora da árvore de acessibilidade', async () => {
    desktop = false;
    useAuth.mockReturnValue({
      logout: jest.fn(),
      user: { nome: 'Tecnico', profile: { nome: 'Técnico' } },
      isAdminGeral: false,
      hasPermission: () => true,
    });

    const { container } = render(<Sidebar isOpen={false} />);
    const aside = container.querySelector('aside');
    await waitFor(() => expect(aside).toHaveAttribute('aria-hidden', 'true'));
    expect(aside).toHaveAttribute('inert');
    expect(screen.queryByRole('link', { name: /Funcionários/i })).not.toBeInTheDocument();
  });

  it('abandona o modo modal ao redimensionar para xl', async () => {
    desktop = false;
    const onClose = jest.fn();
    const onModalChange = jest.fn();
    useAuth.mockReturnValue({
      logout: jest.fn(),
      user: { nome: 'Tecnico', profile: { nome: 'Técnico' } },
      isAdminGeral: false,
      hasPermission: () => true,
    });

    render(<Sidebar isOpen onClose={onClose} onModalChange={onModalChange} />);
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Menu lateral' })).toHaveAttribute('aria-modal', 'true'));

    desktop = true;
    fireEvent(window, new Event('resize'));
    act(() => mediaListener?.());

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const sidebar = screen.getByLabelText('Menu lateral');
    expect(sidebar).not.toHaveAttribute('role', 'dialog');
    expect(sidebar).not.toHaveAttribute('aria-modal');
    await waitFor(() => expect(onModalChange).toHaveBeenLastCalledWith(false));
  });
});
