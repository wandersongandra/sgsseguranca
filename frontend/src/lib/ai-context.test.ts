import { getAiRouteContext } from './ai-context';

describe('getAiRouteContext', () => {
  it('não usa contexto de módulo em falso prefixo de rota', () => {
    const context = getAiRouteContext('/dashboard/pts-evil');

    expect(context.promptPrefix).toContain('apoio geral de SST');
  });

  it('usa contexto de módulo em subrota legítima', () => {
    const context = getAiRouteContext('/dashboard/pts/pt-1');

    expect(context.promptPrefix).toContain('módulo PT');
  });
});
