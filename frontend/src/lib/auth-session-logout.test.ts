import { clearAuthenticatedSession } from './auth-session-state';
import { sessionStore } from './sessionStore';
import { siteStore } from './siteStore';
import { tokenStore } from './tokenStore';

const mockClearSensitiveBrowserStorage = jest.fn();

jest.mock('./browser-sensitive-storage', () => ({
  clearSensitiveBrowserStorage: (...args: unknown[]) =>
    mockClearSensitiveBrowserStorage(...args),
}));

describe('clearAuthenticatedSession', () => {
  beforeEach(() => {
    tokenStore.clear();
    sessionStore.clear();
    siteStore.clear();
    mockClearSensitiveBrowserStorage.mockReset();
    mockClearSensitiveBrowserStorage.mockResolvedValue(undefined);
  });

  it('aguarda a limpeza de storage sensível antes de concluir o logout', async () => {
    let resolveCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      resolveCleanup = resolve;
    });
    mockClearSensitiveBrowserStorage.mockReturnValue(cleanup);

    tokenStore.set('access-token');
    sessionStore.set({ userId: 'user-1', companyId: 'company-1' });
    const pendingSite = siteStore.set({
      siteId: 'site-1',
      siteName: 'Obra antiga',
      companyId: 'company-1',
    });

    const logout = clearAuthenticatedSession();
    expect(logout).toBeInstanceOf(Promise);
    expect(tokenStore.get()).toBeNull();
    expect(sessionStore.get()).toBeNull();
    expect(siteStore.get()).toBeNull();

    let completed = false;
    void logout.then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);

    resolveCleanup();
    await logout;
    await pendingSite;
    expect(completed).toBe(true);
    expect(siteStore.get()).toBeNull();
  });
});
