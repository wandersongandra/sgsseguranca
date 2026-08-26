import { validate } from 'class-validator';
import {
  ActivateBootstrapMfaDto,
  ActivateMfaEnrollmentDto,
  DisableMfaDto,
  VerifyLoginMfaDto,
  VerifyStepUpDto,
} from './mfa.dto';

const RECOVERY_CODE = 'ABCD-EFGH-IJKL-MNOP';

describe('MFA DTO code contract', () => {
  it('accepts a six-digit TOTP and a generated recovery code', async () => {
    const loginTotp = Object.assign(new VerifyLoginMfaDto(), {
      challengeToken: 'challenge',
      code: '123456',
    });
    const loginRecovery = Object.assign(new VerifyLoginMfaDto(), {
      challengeToken: 'challenge',
      code: RECOVERY_CODE,
    });

    await expect(validate(loginTotp)).resolves.toHaveLength(0);
    await expect(validate(loginRecovery)).resolves.toHaveLength(0);
  });

  it('applies the recovery-code contract to activation, disable and step-up', async () => {
    const dtos = [
      Object.assign(new ActivateBootstrapMfaDto(), {
        challengeToken: 'challenge',
        code: RECOVERY_CODE,
      }),
      Object.assign(new ActivateMfaEnrollmentDto(), { code: RECOVERY_CODE }),
      Object.assign(new DisableMfaDto(), { code: RECOVERY_CODE }),
      Object.assign(new VerifyStepUpDto(), {
        reason: 'test-recovery-code',
        code: RECOVERY_CODE,
      }),
    ];

    for (const dto of dtos) {
      await expect(validate(dto)).resolves.toHaveLength(0);
    }
  });

  it('keeps a bounded input contract for MFA codes', async () => {
    const tooShort = Object.assign(new VerifyLoginMfaDto(), {
      challengeToken: 'challenge',
      code: '12345',
    });
    const tooLong = Object.assign(new VerifyLoginMfaDto(), {
      challengeToken: 'challenge',
      code: 'x'.repeat(65),
    });

    await expect(validate(tooShort)).resolves.not.toHaveLength(0);
    await expect(validate(tooLong)).resolves.not.toHaveLength(0);
  });
});
