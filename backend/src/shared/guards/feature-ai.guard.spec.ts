import { ExecutionContext, NotFoundException } from '@nestjs/common';
import { FeatureAiGuard } from './feature-ai.guard';

describe('FeatureAiGuard', () => {
  const original = process.env.FEATURE_AI_ENABLED;
  afterEach(() => {
    if (original === undefined) delete process.env.FEATURE_AI_ENABLED;
    else process.env.FEATURE_AI_ENABLED = original;
  });

  it('rejects HTTP access when the release flag is disabled', () => {
    process.env.FEATURE_AI_ENABLED = 'false';
    expect(() =>
      new FeatureAiGuard().canActivate({} as ExecutionContext),
    ).toThrow(NotFoundException);
  });

  it('preserves enabled HTTP behavior', () => {
    process.env.FEATURE_AI_ENABLED = 'true';
    expect(new FeatureAiGuard().canActivate({} as ExecutionContext)).toBe(true);
  });
});
