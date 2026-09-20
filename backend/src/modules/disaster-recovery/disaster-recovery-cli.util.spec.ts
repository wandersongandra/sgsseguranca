import {
  formatCommandFailure,
  redactCliArg,
  redactCliArgs,
} from './disaster-recovery-cli.util';

describe('disaster recovery CLI redaction', () => {
  it('redige flags sensíveis sem alterar argumentos seguros', () => {
    const args = [
      '--target-db-url=postgresql://user:secret@host/db',
      '--database-url=postgresql://user:secret@host/db',
      '--storage-secret=hidden',
      '--admin-password=hidden',
      '--api-token=hidden',
      '--environment=test',
    ];

    const redacted = redactCliArgs(args);

    expect(redacted).toEqual([
      '--target-db-url=[REDACTED]',
      '--database-url=[REDACTED]',
      '--storage-secret=[REDACTED]',
      '--admin-password=[REDACTED]',
      '--api-token=[REDACTED]',
      '--environment=test',
    ]);
    expect(redacted.join(' ')).not.toContain('postgresql://');
    expect(redacted.join(' ')).not.toContain('hidden');
  });

  it('redige forma separada de flags sensíveis', () => {
    expect(
      redactCliArgs(['--target-db-url', 'postgresql://user:secret@host/db']),
    ).toEqual(['--target-db-url=[REDACTED]', '[REDACTED]']);
    expect(redactCliArg('--target-db-url')).toBe('--target-db-url=[REDACTED]');
    expect(redactCliArg('--foo-secret')).toBe('--foo-secret=[REDACTED]');
    expect(redactCliArg('--verbose')).toBe('--verbose');
  });

  it('formata falha de comando sem expor target-db-url', () => {
    const message = formatCommandFailure({
      command: 'pg_restore',
      args: [
        '--target-db-url=postgresql://user:secret@host/db',
        '--exit-on-error',
      ],
      code: 1,
      details: 'restore failed',
    });

    expect(message).toContain('--target-db-url=[REDACTED]');
    expect(message).toContain('restore failed');
    expect(message).not.toContain('postgresql://');
    expect(message).not.toContain('secret@host');
  });
});
