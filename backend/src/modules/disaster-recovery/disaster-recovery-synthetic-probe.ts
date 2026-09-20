import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DisasterRecoveryReplicaStorageService } from './disaster-recovery-replica-storage.service';

export const SYNTHETIC_PROBE_PAYLOAD_BYTES = 64 * 1024;
export const SYNTHETIC_PROBE_KEY_PREFIX = 'sgs-dr-probe';

type SyntheticProbeStorage = Pick<
  DisasterRecoveryReplicaStorageService,
  'uploadBuffer' | 'downloadFileBuffer' | 'deleteObject'
>;

export type SyntheticStorageProbeReport = {
  mode: 'synthetic-probe';
  probeKey: string;
  upload: 'PASS';
  restore: 'PASS';
  sha256: 'PASS';
  cleanup: 'PASS';
  result: 'PASS';
};

export async function runSyntheticStorageProbe(
  storage: SyntheticProbeStorage,
): Promise<SyntheticStorageProbeReport> {
  const probeKey = `${SYNTHETIC_PROBE_KEY_PREFIX}/${randomUUID()}/probe.bin`;
  const payload = randomBytes(SYNTHETIC_PROBE_PAYLOAD_BYTES);
  const originalSha256 = createHash('sha256').update(payload).digest('hex');
  let uploadSucceeded = false;

  try {
    await storage.uploadBuffer({
      key: probeKey,
      buffer: payload,
      contentType: 'application/octet-stream',
      metadata: {
        'dr-probe': 'synthetic',
      },
    });
    uploadSucceeded = true;

    const restored = await storage.downloadFileBuffer(probeKey);
    const restoredSha256 = createHash('sha256').update(restored).digest('hex');

    if (restoredSha256 !== originalSha256) {
      throw new Error('DR synthetic probe SHA-256 mismatch.');
    }

    return {
      mode: 'synthetic-probe',
      probeKey,
      upload: 'PASS',
      restore: 'PASS',
      sha256: 'PASS',
      cleanup: 'PASS',
      result: 'PASS',
    };
  } finally {
    if (uploadSucceeded) {
      await storage.deleteObject(probeKey);
    }
  }
}
