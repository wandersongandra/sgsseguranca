const SENSITIVE_ARGUMENT_NAME =
  /^--(?:target-db-url|database-url|[^=]*(?:secret|password|token)[^=]*)$/i;

export function redactCliArg(argument: string): string {
  const separatorIndex = argument.indexOf('=');
  const name =
    separatorIndex >= 0 ? argument.slice(0, separatorIndex) : argument;

  return SENSITIVE_ARGUMENT_NAME.test(name) ? `${name}=[REDACTED]` : argument;
}

export function redactCliArgs(argumentsList: readonly string[]): string[] {
  const redacted: string[] = [];
  let redactNext = false;

  for (const argument of argumentsList) {
    if (redactNext) {
      redacted.push('[REDACTED]');
      redactNext = false;
      continue;
    }

    const separatorIndex = argument.indexOf('=');
    const name =
      separatorIndex >= 0 ? argument.slice(0, separatorIndex) : argument;

    if (!SENSITIVE_ARGUMENT_NAME.test(name)) {
      redacted.push(argument);
      continue;
    }

    redacted.push(
      separatorIndex >= 0 ? `${name}=[REDACTED]` : `${argument}=[REDACTED]`,
    );
    redactNext = separatorIndex < 0;
  }

  return redacted;
}

export function formatCommandFailure(input: {
  command: string;
  args: readonly string[];
  code: number | null;
  details?: string;
}): string {
  const details = input.details?.trim();
  return `Command failed: ${input.command} ${redactCliArgs(input.args).join(' ')} (exit ${input.code ?? 'unknown'})${details ? `\n${details}` : ''}`;
}
