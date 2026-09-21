type AiFeatureConfig = {
  get<T = unknown>(key: string): T | undefined;
};

export function isAiFeatureEnabled(config?: AiFeatureConfig): boolean {
  const values: unknown[] = [process.env.FEATURE_AI_ENABLED];
  if (config) values.push(config.get('FEATURE_AI_ENABLED'));
  return values.every((value) => {
    if (value === undefined || value === null) return true;
    if (typeof value === 'boolean') return value;
    if (typeof value !== 'string') return false;
    const normalized = value.trim().toLowerCase();
    // Preserve the existing default; an explicit disabled flag in either
    // source always wins, including after a provider runtime was constructed.
    return normalized === '' || normalized === 'true';
  });
}
