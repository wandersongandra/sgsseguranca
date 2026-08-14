import { BaseService } from './base.service';
import { TenantService } from '../tenant/tenant.service';

/**
 * Regressão de SGS-EPI-SEC-001 (2ª camada de defesa).
 *
 * Mesmo com os overrides tipados nos controllers, `BaseService` precisa
 * remover campos de ciclo de vida controlados pelo servidor. Sem isso:
 *   - PATCH { deleted_at } soft-deleta por uma rota cujo papel exigido
 *     (ADMIN_EMPRESA/TST) é MENOR que o do DELETE (ADMIN_GERAL) e sem passar
 *     pelo @ForensicAuditAction — escalação de privilégio + trilha ausente;
 *   - PATCH { deleted_at: null } ressuscita registro apagado;
 *   - POST { id: '<uuid existente>' } vira UPDATE (repository.save com PK).
 */
type Row = { id: string; nome: string; deleted_at?: Date | null };

class TestService extends BaseService<Row> {
  // Expõe o método protegido para teste direto do contrato de sanitização.
  public sanitize(data: Record<string, unknown>) {
    return (
      this as unknown as {
        sanitizeWritePayload: (d: unknown) => Record<string, unknown>;
      }
    ).sanitizeWritePayload(data);
  }
}

describe('BaseService.sanitizeWritePayload', () => {
  const service = new TestService(
    {} as never,
    { getTenantId: () => 'tenant-a' } as unknown as TenantService,
    'Teste',
  );

  it.each([
    'company_id',
    'empresa_id',
    'profile_id',
    'role',
    'roles',
    'permissions',
    'permissoes',
  ])('remove o campo sensível "%s"', (field) => {
    expect(
      service.sanitize({ nome: 'ok', [field]: 'hostil' }),
    ).not.toHaveProperty(field);
  });

  it.each(['id', 'deleted_at', 'created_at', 'updated_at'])(
    'remove o campo de ciclo de vida "%s" (controlado pelo servidor)',
    (field) => {
      expect(
        service.sanitize({ nome: 'ok', [field]: 'hostil' }),
      ).not.toHaveProperty(field);
    },
  );

  it('não deixa passar deleted_at:null (ressurreição de registro apagado)', () => {
    expect(
      service.sanitize({ nome: 'ok', deleted_at: null }),
    ).not.toHaveProperty('deleted_at');
  });

  it('preserva os campos legítimos de negócio', () => {
    expect(service.sanitize({ nome: 'Capacete', ca: '12345' })).toEqual({
      nome: 'Capacete',
      ca: '12345',
    });
  });
});
