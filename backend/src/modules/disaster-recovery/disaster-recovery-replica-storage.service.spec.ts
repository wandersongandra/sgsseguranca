import { ConfigService } from '@nestjs/config';
import { S3Client } from '@aws-sdk/client-s3';
import { DisasterRecoveryReplicaStorageService } from './disaster-recovery-replica-storage.service';
import type { IntegrationResilienceService } from '../../shared/resilience/integration-resilience.service';

const integrationStub = {} as IntegrationResilienceService;

describe('DisasterRecoveryReplicaStorageService configuration bootstrap', () => {
  it('inicializa com boolean Joi/ConfigService sem lançar TypeError', () => {
    const config = new ConfigService({
      DR_STORAGE_REPLICA_BUCKET: 'dr-bucket',
      DR_STORAGE_REPLICA_ENDPOINT: 'https://dr.example.invalid',
      DR_STORAGE_REPLICA_REGION: 'auto',
      DR_STORAGE_REPLICA_ACCESS_KEY_ID: 'dr-access',
      DR_STORAGE_REPLICA_SECRET_ACCESS_KEY: 'dr-secret',
      DR_STORAGE_REPLICA_FORCE_PATH_STYLE: false,
      AWS_BUCKET_NAME: 'primary-bucket',
      AWS_ACCESS_KEY_ID: 'primary-access',
      AWS_SECRET_ACCESS_KEY: 'primary-secret',
    });

    const service = new DisasterRecoveryReplicaStorageService(
      config,
      integrationStub,
    );

    expect(service.isConfigured()).toBe(true);
    expect(service.getConfigurationSummary()).toEqual({
      configured: true,
      bucketName: 'dr-bucket',
      endpoint: 'https://dr.example.invalid',
    });
  });

  it('inicializa desabilitado quando Joi injeta somente boolean/defaults de DR', () => {
    const config = new ConfigService({
      DR_STORAGE_REPLICA_REGION: 'auto',
      DR_STORAGE_REPLICA_FORCE_PATH_STYLE: false,
    });

    const service = new DisasterRecoveryReplicaStorageService(
      config,
      integrationStub,
    );

    expect(service.isConfigured()).toBe(false);
    expect(service.getConfigurationSummary()).toEqual({
      configured: false,
      bucketName: null,
      endpoint: null,
    });
  });

  it('falha fechado no bootstrap para réplica parcial', () => {
    const config = new ConfigService({
      DR_STORAGE_REPLICA_BUCKET: 'dr-bucket',
      DR_STORAGE_REPLICA_ENDPOINT: 'https://dr.example.invalid',
      DR_STORAGE_REPLICA_FORCE_PATH_STYLE: false,
      AWS_ACCESS_KEY_ID: 'primary-access',
      AWS_SECRET_ACCESS_KEY: 'primary-secret',
    });

    expect(
      () => new DisasterRecoveryReplicaStorageService(config, integrationStub),
    ).toThrow('DR_STORAGE_REPLICA_ACCESS_KEY_ID');
  });

  it('falha fechado no bootstrap quando segredo primário é reutilizado e não o expõe', () => {
    const sensitive = 'same-sensitive-secret';
    const config = new ConfigService({
      DR_STORAGE_REPLICA_BUCKET: 'dr-bucket',
      DR_STORAGE_REPLICA_ENDPOINT: 'https://dr.example.invalid',
      DR_STORAGE_REPLICA_ACCESS_KEY_ID: 'dr-access',
      DR_STORAGE_REPLICA_SECRET_ACCESS_KEY: sensitive,
      DR_STORAGE_REPLICA_FORCE_PATH_STYLE: true,
      AWS_BUCKET_NAME: 'primary-bucket',
      AWS_ACCESS_KEY_ID: 'primary-access',
      AWS_SECRET_ACCESS_KEY: sensitive,
    });

    let message = '';
    try {
      new DisasterRecoveryReplicaStorageService(config, integrationStub);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('replica secret must be independent');
    expect(message).not.toContain(sensitive);
  });

  it('permite excluir somente a chave do probe sintético na réplica', async () => {
    const config = new ConfigService({
      DR_STORAGE_REPLICA_BUCKET: 'dr-bucket',
      DR_STORAGE_REPLICA_ENDPOINT: 'https://dr.example.invalid',
      DR_STORAGE_REPLICA_REGION: 'auto',
      DR_STORAGE_REPLICA_ACCESS_KEY_ID: 'dr-access',
      DR_STORAGE_REPLICA_SECRET_ACCESS_KEY: 'dr-secret',
      DR_STORAGE_REPLICA_FORCE_PATH_STYLE: false,
    });
    const execute = jest.fn((_name: string, operation: () => unknown) =>
      operation(),
    );
    const integration = { execute } as unknown as IntegrationResilienceService;
    const service = new DisasterRecoveryReplicaStorageService(
      config,
      integration,
    );
    const send = jest
      .spyOn(S3Client.prototype, 'send')
      .mockResolvedValue({} as never);
    const key = 'sgs-dr-probe/00000000-0000-4000-8000-000000000000/probe.bin';

    await service.deleteObject(key);

    expect(execute).toHaveBeenCalledWith(
      'dr_storage_replica_delete_object',
      expect.any(Function),
      { timeoutMs: 10_000 },
    );
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: {
          Bucket: 'dr-bucket',
          Key: key,
        },
      }),
    );
    send.mockRestore();
  });

  it('recusa exclusão de objeto fora do namespace do probe', async () => {
    const config = new ConfigService({
      DR_STORAGE_REPLICA_BUCKET: 'dr-bucket',
      DR_STORAGE_REPLICA_ENDPOINT: 'https://dr.example.invalid',
      DR_STORAGE_REPLICA_ACCESS_KEY_ID: 'dr-access',
      DR_STORAGE_REPLICA_SECRET_ACCESS_KEY: 'dr-secret',
    });
    const service = new DisasterRecoveryReplicaStorageService(
      config,
      integrationStub,
    );

    await expect(
      service.deleteObject('documents/customer/file.pdf'),
    ).rejects.toThrow('restrita a objetos do probe sintético');
    await expect(
      service.deleteObject('sgs-dr-probe/not-a-uuid/probe.bin'),
    ).rejects.toThrow('restrita a objetos do probe sintético');
  });
});
