import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { UpdatePtApprovalRulesDto } from './update-pt-approval-rules.dto';

/**
 * Regressão de SGS-PT-BR-003.
 *
 * A rota `PATCH /pts/approval-rules` roda sob `whitelist` +
 * `forbidNonWhitelisted`. Toda regra que exista em
 * `PtsService.defaultApprovalRules` mas NÃO exista neste DTO é rejeitada pelo
 * pipe e fica permanentemente presa no default.
 *
 * Foi o que aconteceu com as quatro regras de NR-33 e de evidência prévia:
 * todas com default `false` e sem caminho de escrita — o bloco inteiro de
 * conformidade NR-33 em `assertCanApprove` era código morto em produção.
 *
 * A lista abaixo é a fonte da verdade do contrato. Ao adicionar uma regra em
 * `defaultApprovalRules`, adicione-a aqui e no DTO.
 */
const REGRAS_DE_APROVACAO = [
  'blockCriticalRiskWithoutEvidence',
  'blockWorkerWithoutValidMedicalExam',
  'blockWorkerWithExpiredBlockingTraining',
  'requireAtLeastOneExecutante',
  'blockConfinedSpaceWithoutAtmosphericReadings',
  'blockConfinedSpaceWithoutWatch',
  'blockConfinedSpaceWithoutRescuePlan',
  'blockWithoutBeforeEvidence',
] as const;

describe('UpdatePtApprovalRulesDto', () => {
  it.each(REGRAS_DE_APROVACAO)(
    'aceita a regra "%s" (sem isso ela é inalcançável pela API)',
    (rule) => {
      const dto = plainToInstance(UpdatePtApprovalRulesDto, { [rule]: true });
      expect(validateSync(dto)).toHaveLength(0);
      expect(dto[rule]).toBe(true);
    },
  );

  it('aceita as 8 regras de uma vez', () => {
    const payload = Object.fromEntries(
      REGRAS_DE_APROVACAO.map((rule) => [rule, true]),
    );
    const dto = plainToInstance(UpdatePtApprovalRulesDto, payload);
    expect(validateSync(dto)).toHaveLength(0);
    expect(Object.keys(dto).sort()).toEqual([...REGRAS_DE_APROVACAO].sort());
  });

  it('rejeita valor não booleano', () => {
    const dto = plainToInstance(UpdatePtApprovalRulesDto, {
      blockConfinedSpaceWithoutWatch: 'sim',
    });
    expect(validateSync(dto).length).toBeGreaterThan(0);
  });
});
