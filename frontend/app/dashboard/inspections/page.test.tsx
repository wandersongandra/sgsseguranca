import { redirect } from 'next/navigation';
import InspectionsAliasPage from './page';

jest.mock('next/navigation', () => ({
  redirect: jest.fn(),
}));

describe('dashboard/inspections alias', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('redireciona para a rota canônica preservando parâmetros e listas', async () => {
    await InspectionsAliasPage({
      searchParams: Promise.resolve({
        site: 'site-a',
        page: '2',
        filter: ['open', 'critical'],
      }),
    });

    expect(redirect).toHaveBeenCalledWith(
      '/dashboard/audits?site=site-a&page=2&filter=open&filter=critical',
    );
  });

  it('não acrescenta interrogação quando não há parâmetros', async () => {
    await InspectionsAliasPage({ searchParams: Promise.resolve({}) });

    expect(redirect).toHaveBeenCalledWith('/dashboard/audits');
  });
});
