import { clearSensitiveBrowserStorage } from './browser-sensitive-storage';
import { siteStore } from './siteStore';

jest.mock('./browser-sensitive-storage', () => ({
  clearSensitiveBrowserStorage: jest.fn(),
}));

const clearSensitiveStorageMock = jest.mocked(clearSensitiveBrowserStorage);

describe('siteStore isolation', () => {
  beforeEach(() => {
    siteStore.clear();
    sessionStorage.clear();
    clearSensitiveStorageMock.mockReset();
    clearSensitiveStorageMock.mockResolvedValue(undefined);
  });

  it('não ressuscita obra depois de um clear durante a limpeza', async () => {
    await siteStore.set({ siteId: 'site-a', siteName: 'Obra A', companyId: 'tenant-a' });
    let finishClear!: () => void;
    clearSensitiveStorageMock.mockImplementationOnce(
      () => new Promise<void>((resolve) => { finishClear = resolve; }),
    );

    const changing = siteStore.set({ siteId: 'site-b', siteName: 'Obra B', companyId: 'tenant-a' });
    await Promise.resolve();
    siteStore.clear();

    finishClear();
    await changing;

    expect(siteStore.get()).toBeNull();
    expect(sessionStorage.getItem('cx_selected_site')).toBeNull();
  });

  it('descarta obra enfileirada depois de um clear antes da execução', async () => {
    const pending = siteStore.set({ siteId: 'site-a', siteName: 'Obra A', companyId: 'tenant-a' });
    siteStore.clear();

    await pending;

    expect(siteStore.get()).toBeNull();
    expect(sessionStorage.getItem('cx_selected_site')).toBeNull();
  });
});
