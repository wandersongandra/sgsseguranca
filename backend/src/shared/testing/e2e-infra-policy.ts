export function isE2EInfraSkipAllowed(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const isCi = /^(true|1)$/i.test(env.CI ?? '');
  const isProduction = env.NODE_ENV === 'production';
  const explicitlyAllowed = /^(true|1)$/i.test(env.E2E_ALLOW_INFRA_SKIP ?? '');

  // Infra ausente nunca pode ser mascarada em CI/release. Para desenvolvimento
  // local, o skip exige opt-in explícito por variável de ambiente.
  return !isCi && !isProduction && explicitlyAllowed;
}
