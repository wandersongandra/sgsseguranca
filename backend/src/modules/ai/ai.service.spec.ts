import { UnauthorizedException } from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { Repository } from 'typeorm';
import { AiService } from './ai.service';
import { AiInteraction } from './entities/ai-interaction.entity';
import { requestContextStorage } from '../../shared/middleware/request-context.middleware';

const TENANT_ID = '550e8400-e29b-41d4-a716-446655440010';
const AUTH_USER_ID = '550e8400-e29b-41d4-a716-446655440011';
const INSPECTOR_ID = '550e8400-e29b-41d4-a716-446655440012';
const SITE_ID = '550e8400-e29b-41d4-a716-446655440013';

function withRequestContext<T>(
  values: Record<string, string>,
  callback: () => Promise<T>,
): Promise<T> {
  const store = new Map<string, string>(Object.entries(values));
  return new Promise<T>((resolve, reject) => {
    requestContextStorage.run(store, () => {
      callback().then(resolve).catch(reject);
    });
  });
}

function makeService() {
  const create = jest.fn((payload: Partial<AiInteraction>) => ({
    id: 'interaction-1',
    ...payload,
  }));
  const save = jest.fn((payload: Partial<AiInteraction>) =>
    Promise.resolve(payload as AiInteraction),
  );
  const interactionRepo = {
    create,
    save,
  } as unknown as Repository<AiInteraction>;

  const configService = {
    get: jest.fn((key: string) => {
      if (key === 'OPENAI_MODEL') return 'gpt-5-mini';
      if (key === 'OPENAI_REASONING_EFFORT') return 'medium';
      return undefined;
    }),
  };

  const tenantService = {
    getTenantId: jest.fn(() => TENANT_ID),
  };

  const rateLimitService = {
    checkAndConsume: jest.fn(() =>
      Promise.resolve({
        allowed: true,
        remaining: { perMinute: 9, perDay: 99 },
      }),
    ),
  };

  const checklistsService = {
    findOneEntity: jest.fn(),
  };

  const nonConformitiesService = {
    create: jest.fn(),
  };

  const pdfQueue = {
    add: jest.fn(() => Promise.resolve({ id: 'job-1' })),
  } as unknown as Queue;

  const service = new AiService(
    interactionRepo,
    configService as never,
    tenantService as never,
    rateLimitService as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    checklistsService as never,
    {} as never,
    {} as never,
    nonConformitiesService as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    pdfQueue,
  );

  return {
    service,
    interactionRepo,
    create,
    save,
    checklistsService,
    nonConformitiesService,
    pdfQueue,
  };
}

describe('AiService', () => {
  it('queueMonthlyReport falha fechado sem usuário autenticado válido', async () => {
    const { service } = makeService();

    await expect(
      withRequestContext({ companyId: TENANT_ID }, () =>
        service.queueMonthlyReport({ ano: 2026, mes: 3 }),
      ),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('generateChecklist persiste user_id do contexto autenticado, não inspetor_id', async () => {
    const { service, create } = makeService();
    jest.spyOn(service as never, 'callOpenAiJson' as never).mockResolvedValue({
      data: {
        titulo: 'Checklist gerado',
        itens: [{ item: 'Verificar guarda-corpo' }],
        confidence: 'medium',
        notes: [],
      },
      inputTokens: 10,
      outputTokens: 20,
    } as never);

    await withRequestContext(
      { companyId: TENANT_ID, userId: AUTH_USER_ID },
      async () => {
        await service.generateChecklist({
          titulo: 'Checklist',
          descricao: 'Desc',
          inspetor_id: INSPECTOR_ID,
          site_id: SITE_ID,
        });
      },
    );

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        company_id: TENANT_ID,
        user_id: AUTH_USER_ID,
      }),
    );
  });

  it('generateStructuredJson falha fechado com userId sentinela', async () => {
    const { service } = makeService();

    await expect(
      withRequestContext(
        { companyId: TENANT_ID, userId: 'unknown' },
        async () =>
          service.generateStructuredJson({
            task: 'generic',
            prompt: 'teste',
          }),
      ),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('generateAprDraft rejeita company_id vindo do client antes de montar contexto de IA', async () => {
    const { service } = makeService();

    await expect(
      withRequestContext(
        { companyId: TENANT_ID, userId: AUTH_USER_ID },
        async () =>
          service.generateAprDraft({
            site_id: SITE_ID,
            elaborador_id: AUTH_USER_ID,
            company_id: 'tenant-forjado',
          } as never),
      ),
    ).rejects.toThrow('company_id não é permitido no payload');
  });

  it('generatePtDraft rejeita company_id vindo do client antes de montar contexto de IA', async () => {
    const { service } = makeService();

    await expect(
      withRequestContext(
        { companyId: TENANT_ID, userId: AUTH_USER_ID },
        async () =>
          service.generatePtDraft({
            site_id: SITE_ID,
            responsavel_id: AUTH_USER_ID,
            company_id: 'tenant-forjado',
          } as never),
      ),
    ).rejects.toThrow('company_id não é permitido no payload');
  });

  it('minimiza textos livres da NC e do checklist antes de enviar à Sophie e de persistir a interação', async () => {
    const { service, create, save, checklistsService, nonConformitiesService } =
      makeService();
    const sensitiveValues = [
      'NOME-SECRETO-ANA-SOUZA',
      'DESCRICAO-NC-SEGREDO',
      'ACAO-IMEDIATA-SEGREDO',
      'OBSERVACAO-SNAPSHOT-SEGREDO',
      'CONTEXTO-ORIGEM-SEGREDO',
    ];
    let submittedPrompt = '';

    checklistsService.findOneEntity.mockResolvedValue({
      id: '550e8400-e29b-41d4-a716-446655440020',
      titulo: 'Checklist de NOME-SECRETO-ANA-SOUZA',
      descricao: 'OBSERVACAO-SNAPSHOT-SEGREDO',
      equipamento: 'Equipamento de NOME-SECRETO-ANA-SOUZA',
      maquina: 'Máquina de NOME-SECRETO-ANA-SOUZA',
      status: 'Não Conforme',
      site_id: SITE_ID,
      site: { nome: 'Área de NOME-SECRETO-ANA-SOUZA' },
      itens: [
        {
          item: 'Item de NOME-SECRETO-ANA-SOUZA',
          status: 'Não Conforme',
          criticidade: 'critico',
          tipo_resposta: 'sim_nao',
          acao_corretiva_imediata: 'ACAO-IMEDIATA-SEGREDO',
          observacao: 'OBSERVACAO-SNAPSHOT-SEGREDO',
          resposta: 'OBSERVACAO-SNAPSHOT-SEGREDO',
          bloqueia_operacao_quando_nc: true,
          exige_foto_quando_nc: true,
          exige_observacao_quando_nc: true,
        },
      ],
    });
    nonConformitiesService.create.mockResolvedValue({
      id: 'nc-1',
      codigo_nc: 'NC-TESTE-1',
    });

    jest
      .spyOn(
        service as unknown as {
          callOpenAiJson: (params: { user: string }) => Promise<unknown>;
        },
        'callOpenAiJson',
      )
      .mockImplementation((params) => {
        submittedPrompt = params.user;
        return Promise.resolve({
          data: {
            tipo: 'DESVIO_OPERACIONAL',
            classificacao: ['SOPHIE'],
            descricao: 'Desvio operacional técnico.',
            evidencia_observada: 'Evidência técnica.',
            condicao_insegura: 'Condição técnica.',
            risco_nivel: 'Alto',
          },
          inputTokens: 10,
          outputTokens: 20,
        });
      });

    await withRequestContext(
      { companyId: TENANT_ID, userId: AUTH_USER_ID },
      () =>
        service.createNonConformity({
          source_type: 'checklist',
          source_reference: '550e8400-e29b-41d4-a716-446655440020',
          site_id: SITE_ID,
          title: 'NOME-SECRETO-ANA-SOUZA',
          description: 'DESCRICAO-NC-SEGREDO',
          local_setor_area: 'Área de NOME-SECRETO-ANA-SOUZA',
          responsavel_area: 'NOME-SECRETO-ANA-SOUZA',
          source_context: 'CONTEXTO-ORIGEM-SEGREDO',
        }),
    );

    for (const sensitiveValue of sensitiveValues) {
      expect(submittedPrompt).not.toContain(sensitiveValue);
      expect(JSON.stringify(create.mock.calls)).not.toContain(sensitiveValue);
      expect(JSON.stringify(save.mock.calls)).not.toContain(sensitiveValue);
    }
    expect(submittedPrompt).toContain('"nonconforming_items":1');
    expect(submittedPrompt).toContain('"critico":1');
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ question: 'GENERATE_JSON(generic)' }),
    );
  });

  it('analisa checklist com metadados técnicos, sem reenviar texto livre ao provedor', async () => {
    const { service, checklistsService } = makeService();
    const sensitiveValue = 'CHECKLIST-TEXTO-LIVRE-SEGREDO';
    let submittedPrompt = '';

    checklistsService.findOneEntity.mockResolvedValue({
      id: '550e8400-e29b-41d4-a716-446655440021',
      titulo: sensitiveValue,
      descricao: sensitiveValue,
      equipamento: sensitiveValue,
      maquina: sensitiveValue,
      status: 'Não Conforme',
      itens: [
        {
          item: sensitiveValue,
          status: 'não',
          criticidade: 'alto',
          tipo_resposta: 'sim_nao',
          acao_corretiva_imediata: sensitiveValue,
          observacao: sensitiveValue,
          resposta: sensitiveValue,
        },
      ],
    });

    jest
      .spyOn(
        service as unknown as {
          callOpenAiJson: (params: { user: string }) => Promise<unknown>;
        },
        'callOpenAiJson',
      )
      .mockImplementation((params) => {
        submittedPrompt = params.user;
        return Promise.resolve({
          data: {
            summary: 'Análise técnica disponível.',
            suggestions: ['Priorizar ação corretiva.'],
            confidence: 'medium',
            notes: [],
          },
          inputTokens: 10,
          outputTokens: 20,
        });
      });

    await withRequestContext(
      { companyId: TENANT_ID, userId: AUTH_USER_ID },
      () => service.analyzeChecklist('550e8400-e29b-41d4-a716-446655440021'),
    );

    expect(submittedPrompt).not.toContain(sensitiveValue);
    expect(submittedPrompt).toContain('"nonconforming_items":1');
    expect(submittedPrompt).toContain('"alto":1');
  });

  it('reduz a origem de imagem a flags e contagens, sem enviar narrativas livres', async () => {
    const { service, nonConformitiesService } = makeService();
    const sensitiveValues = [
      'DESCRICAO-IMAGEM-SEGREDO',
      'RISCO-IMAGEM-SEGREDO',
      'ACAO-IMAGEM-SEGREDO',
      'NOTA-IMAGEM-SEGREDO',
    ];
    let submittedPrompt = '';

    nonConformitiesService.create.mockResolvedValue({
      id: 'nc-image-1',
      codigo_nc: 'NC-IMAGE-1',
    });
    jest
      .spyOn(
        service as unknown as {
          callOpenAiJson: (params: { user: string }) => Promise<unknown>;
        },
        'callOpenAiJson',
      )
      .mockImplementation((params) => {
        submittedPrompt = params.user;
        return Promise.resolve({
          data: {
            descricao: 'Desvio operacional técnico.',
            evidencia_observada: 'Evidência técnica.',
            condicao_insegura: 'Condição técnica.',
            risco_nivel: 'Médio',
          },
          inputTokens: 10,
          outputTokens: 20,
        });
      });

    await withRequestContext(
      { companyId: TENANT_ID, userId: AUTH_USER_ID },
      () =>
        service.createNonConformity({
          source_type: 'image',
          site_id: SITE_ID,
          description: 'DESCRICAO-IMAGEM-SEGREDO',
          source_context: 'DESCRICAO-IMAGEM-SEGREDO',
          image_analysis_summary: 'DESCRICAO-IMAGEM-SEGREDO',
          image_risks: ['RISCO-IMAGEM-SEGREDO'],
          image_actions: ['ACAO-IMAGEM-SEGREDO'],
          image_notes: 'NOTA-IMAGEM-SEGREDO',
        }),
    );

    for (const sensitiveValue of sensitiveValues) {
      expect(submittedPrompt).not.toContain(sensitiveValue);
    }
    expect(submittedPrompt).toContain('"summary_available":true');
    expect(submittedPrompt).toContain('"risk_signal_count":1');
    expect(submittedPrompt).toContain('"action_signal_count":1');
  });
});
