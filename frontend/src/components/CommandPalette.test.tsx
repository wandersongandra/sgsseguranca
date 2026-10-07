import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Permission } from '@/lib/permissions';
import { CommandPalette } from './CommandPalette';

const push = jest.fn();
const useAuth = jest.fn();
const findAprs = jest.fn();
const findUsers = jest.fn();
let tenantListener: ((tenant: { companyId: string } | null) => void) | undefined;

jest.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
jest.mock('@/context/AuthContext', () => ({ useAuth: () => useAuth() }));
jest.mock('@/services/aprsService', () => ({ aprsService: { findPaginated: (...args: unknown[]) => findAprs(...args) } }));
jest.mock('@/services/usersService', () => ({ usersService: { findPaginated: (...args: unknown[]) => findUsers(...args) } }));
jest.mock('@/lib/selectedTenantStore', () => ({
  selectedTenantStore: {
    get: () => ({ companyId: 'tenant-a', companyName: 'Tenant A' }),
    subscribe: (listener: (tenant: { companyId: string } | null) => void) => {
      tenantListener = listener;
      return () => { tenantListener = undefined; };
    },
  },
}));

function response(data: Array<Record<string, unknown>>) {
  return { data, page: 1, limit: 4, total: data.length, totalPages: 1 };
}

function openPalette() {
  act(() => window.dispatchEvent(new Event('app:command-palette-open')));
  return screen.getByRole('combobox', { name: 'Buscar ações rápidas' });
}

async function runDebounce() {
  await act(async () => { jest.advanceTimersByTime(300); });
}

describe('CommandPalette', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    tenantListener = undefined;
    findAprs.mockResolvedValue(response([]));
    findUsers.mockResolvedValue(response([]));
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('não consulta nem mostra usuários sem CAN_MANAGE_USERS', async () => {
    useAuth.mockReturnValue({
      user: { company_id: 'tenant-a' },
      isAdminGeral: false,
      hasPermission: (permission: string) => permission === Permission.CAN_VIEW_APR,
    });
    findAprs.mockResolvedValue(response([{ id: '1', numero: '10', titulo: 'Altura', status: 'Pendente', company_id: 'tenant-a' }]));

    render(<CommandPalette />);
    fireEvent.change(openPalette(), { target: { value: 'alt' } });
    await runDebounce();

    expect(findUsers).not.toHaveBeenCalled();
    expect(findAprs).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'tenant-a', search: 'alt' }));
    expect(await screen.findByRole('option', { name: /APR 10/ })).toBeInTheDocument();
  });

  it('consulta usuários para gestor e rejeita resultados de outro tenant', async () => {
    useAuth.mockReturnValue({
      user: { company_id: 'tenant-a' },
      isAdminGeral: false,
      hasPermission: (permission: string) => permission === Permission.CAN_MANAGE_USERS,
    });
    findUsers.mockResolvedValue(response([
      { id: '1', nome: 'Alice', email: 'alice@example.com', company_id: 'tenant-a' },
      { id: '2', nome: 'Mallory', email: 'mallory@example.com', company_id: 'tenant-b' },
    ]));

    render(<CommandPalette />);
    fireEvent.change(openPalette(), { target: { value: 'ali' } });
    await runDebounce();

    expect(findAprs).not.toHaveBeenCalled();
    expect(await screen.findByRole('option', { name: /Alice/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Mallory/ })).not.toBeInTheDocument();
  });

  it('ignora resposta antiga após mudança da query', async () => {
    useAuth.mockReturnValue({
      user: { company_id: 'tenant-a' },
      isAdminGeral: false,
      hasPermission: (permission: string) => permission === Permission.CAN_VIEW_APR,
    });
    let resolveOld!: (value: ReturnType<typeof response>) => void;
    let resolveNew!: (value: ReturnType<typeof response>) => void;
    findAprs
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveNew = resolve; }));

    render(<CommandPalette />);
    const input = openPalette();
    fireEvent.change(input, { target: { value: 'antiga' } });
    await runDebounce();
    fireEvent.change(input, { target: { value: 'nova' } });
    await runDebounce();

    await act(async () => resolveNew(response([{ id: 'new', numero: '2', titulo: 'Nova', status: 'Pendente', company_id: 'tenant-a' }])));
    expect(await screen.findByRole('option', { name: /Nova/ })).toBeInTheDocument();
    await act(async () => resolveOld(response([{ id: 'old', numero: '1', titulo: 'Antiga', status: 'Pendente', company_id: 'tenant-a' }])));
    expect(screen.queryByRole('option', { name: /Antiga/ })).not.toBeInTheDocument();
  });

  it('cancela busca ao fechar ou trocar tenant e expõe combobox/listbox/options coerentes', async () => {
    useAuth.mockReturnValue({
      user: { company_id: 'ignored-for-admin' },
      isAdminGeral: true,
      hasPermission: () => true,
    });
    let requestSignal: AbortSignal | undefined;
    findAprs.mockImplementation((options: { signal: AbortSignal }) => {
      requestSignal = options.signal;
      return new Promise(() => undefined);
    });
    findUsers.mockResolvedValue(response([]));

    render(<CommandPalette />);
    const input = openPalette();
    expect(input).toHaveAttribute('aria-expanded', 'true');
    expect(input).toHaveAttribute('aria-controls', 'command-palette-results');
    expect(screen.getByRole('listbox', { name: 'Resultados' })).toBeInTheDocument();
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');
    expect(input).toHaveAttribute('aria-activedescendant', screen.getAllByRole('option')[0]!.id);

    fireEvent.change(input, { target: { value: 'busca' } });
    await runDebounce();
    expect(requestSignal?.aborted).toBe(false);
    act(() => tenantListener?.({ companyId: 'tenant-b' }));
    expect(requestSignal?.aborted).toBe(true);

    await runDebounce();
    expect(requestSignal?.aborted).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Fechar busca' }));
    expect(requestSignal?.aborted).toBe(true);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Paleta de comandos' })).not.toBeInTheDocument());
  });
});
