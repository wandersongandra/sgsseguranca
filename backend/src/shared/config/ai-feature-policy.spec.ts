import { ConfigService } from '@nestjs/config';
import { isAiFeatureEnabled } from './ai-feature-policy';

describe('AI feature policy', () => {
  const original = process.env.FEATURE_AI_ENABLED;
  beforeEach(() => {
    delete process.env.FEATURE_AI_ENABLED;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.FEATURE_AI_ENABLED;
    else process.env.FEATURE_AI_ENABLED = original;
  });

  it.each([false, 'false', ' FALSE ', 'invalid', 1])(
    'fails closed for disabled or invalid config: %s',
    (flag) => {
      expect(
        isAiFeatureEnabled(new ConfigService({ FEATURE_AI_ENABLED: flag })),
      ).toBe(false);
    },
  );

  it('does not allow cached enabled config to override an environment shutdown', () => {
    process.env.FEATURE_AI_ENABLED = 'false';
    expect(
      isAiFeatureEnabled(new ConfigService({ FEATURE_AI_ENABLED: true })),
    ).toBe(false);
  });

  it('preserves enabled behavior when no flag is specified', () => {
    expect(isAiFeatureEnabled()).toBe(true);
  });
});
