import { clearSensitiveBrowserStorage } from './browser-sensitive-storage';
import { selectedTenantStore } from './selectedTenantStore';
import { siteStore } from './siteStore';

jest.mock('./browser-sensitive-storage', () => ({
  clearSensitiveBrowserStorage: jest.fn(),
}));

const clearSensitiveStorageMock = jest.mocked(clearSensitiveBrowserStorage);

describe('selectedTenantStore isolation', () => {
  beforeEach(() => {
    selectedTenantStore.clear();
    siteStore.clear();
    sessionStorage.clear();
    clearSensitiveStorageMock.mockReset();
    clearSensitiveStorageMock.mockResolvedValue(undefined);
  });

  it('clears offline data before changing to another tenant', async () => {
    await selectedTenantStore.set({ companyId: 'tenant-a', companyName: 'Empresa A' });
    await selectedTenantStore.set({ companyId: 'tenant-b', companyName: 'Empresa B' });
    expect(clearSensitiveStorageMock).toHaveBeenCalledTimes(1);
    expect(selectedTenantStore.get()?.companyId).toBe('tenant-b');
  });

  it('does not discard offline work when selecting the same tenant', async () => {
    await selectedTenantStore.set({ companyId: 'tenant-a', companyName: 'Empresa A' });
    await selectedTenantStore.set({ companyId: 'tenant-a', companyName: 'Empresa A atualizada' });
    expect(clearSensitiveStorageMock).not.toHaveBeenCalled();
  });

  it('só notifica o novo tenant depois da limpeza assíncrona', async () => {
    await selectedTenantStore.set({ companyId: 'tenant-a', companyName: 'Empresa A' });
    let finishClear!: () => void;
    clearSensitiveStorageMock.mockImplementationOnce(
      () => new Promise<void>((resolve) => { finishClear = resolve; }),
    );
    const listener = jest.fn();
    const unsubscribe = selectedTenantStore.subscribe(listener);

    const changing = selectedTenantStore.set({ companyId: 'tenant-b', companyName: 'Empresa B' });
    await Promise.resolve();
    expect(listener).not.toHaveBeenCalled();
    expect(selectedTenantStore.get()?.companyId).toBe('tenant-a');

    finishClear();
    await changing;
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'tenant-b' }));
    unsubscribe();
  });

  it('não ressuscita tenant depois de um clear durante a limpeza', async () => {
    await selectedTenantStore.set({ companyId: 'tenant-a', companyName: 'Empresa A' });
    let finishClear!: () => void;
    clearSensitiveStorageMock.mockImplementationOnce(
      () => new Promise<void>((resolve) => { finishClear = resolve; }),
    );

    const changing = selectedTenantStore.set({ companyId: 'tenant-b', companyName: 'Empresa B' });
    await Promise.resolve();
    selectedTenantStore.clear();

    finishClear();
    await changing;

    expect(selectedTenantStore.get()).toBeNull();
    expect(sessionStorage.getItem('cx_selected_tenant')).toBeNull();
  });

  it('descarta tenant enfileirado depois de um clear antes da execução', async () => {
    const pending = selectedTenantStore.set({ companyId: 'tenant-a', companyName: 'Empresa A' });
    selectedTenantStore.clear();

    await pending;

    expect(selectedTenantStore.get()).toBeNull();
    expect(sessionStorage.getItem('cx_selected_tenant')).toBeNull();
  });

  it('limpa a obra selecionada ao limpar o tenant', async () => {
    await selectedTenantStore.set({ companyId: 'tenant-a', companyName: 'Empresa A' });
    await siteStore.set({ siteId: 'site-a', siteName: 'Obra A', companyId: 'tenant-a' });

    selectedTenantStore.clear();

    expect(siteStore.get()).toBeNull();
    expect(sessionStorage.getItem('cx_selected_site')).toBeNull();
  });
});
