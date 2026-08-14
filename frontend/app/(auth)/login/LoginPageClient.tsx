'use client';

import React, { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import Script from 'next/script';
import { useSearchParams } from 'next/navigation';
import { isAxiosError } from 'axios';
import { QRCodeCanvas } from 'qrcode.react';
import {
  AlertCircle,
  BadgeCheck,
  Check,
  Copy,
  Eye,
  EyeOff,
  Lock,
  Shield,
  User as UserIcon,
} from 'lucide-react';
import styles from './login.module.css';
import { authService } from '@/services/authService';
import { useAuth } from '@/context/AuthContext';
import { formatCpfInput } from '@/lib/format/cpf';
import Image from 'next/image';

// Versão do app, injetada no build a partir de frontend/package.json
// (env NEXT_PUBLIC_APP_VERSION definido em next.config.mjs).
const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? '';

declare global {
  interface Window {
    turnstile?: {
      render: (
        container: HTMLElement,
        options: Record<string, unknown>,
      ) => string;
      reset: (widgetId?: string) => void;
      remove: (widgetId?: string) => void;
    };
  }
}

type LoginPageClientProps = {
  turnstileSiteKey: string;
  nonce?: string;
  supportHref: string;
};

function LoginPageContent({ turnstileSiteKey, nonce, supportHref }: LoginPageClientProps) {
  const searchParams = useSearchParams();
  const sessionExpired = searchParams.get('expired') === '1';

  const [cpf, setCpf] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [mfaStage, setMfaStage] = useState<'none' | 'challenge' | 'bootstrap'>('none');
  const [mfaChallengeToken, setMfaChallengeToken] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [mfaManualEntryKey, setMfaManualEntryKey] = useState('');
  const [mfaRecoveryCodes, setMfaRecoveryCodes] = useState<string[]>([]);
  const [mfaOtpAuthUrl, setMfaOtpAuthUrl] = useState('');

  const { login, finalizeLogin } = useAuth();
  const [turnstileToken, setTurnstileToken] = useState('');
  const [turnstileError, setTurnstileError] = useState(false);
  const [turnstileScriptReady, setTurnstileScriptReady] = useState(false);
  const turnstileEnabled = turnstileSiteKey.length > 0;
  const shouldRenderTurnstile = turnstileEnabled && mfaStage === 'none';
  const currentTurnstileTheme = 'light';
  const turnstileContainerRef = React.useRef<HTMLDivElement>(null);
  const turnstileWidgetIdRef = React.useRef<string | null>(null);

  const resetTurnstile = React.useCallback(() => {
    setTurnstileError(false);
    setTurnstileToken('');
    if (turnstileWidgetIdRef.current && window.turnstile?.reset) {
      window.turnstile.reset(turnstileWidgetIdRef.current);
    }
  }, []);

  useEffect(() => {
    if (
      !shouldRenderTurnstile ||
      !turnstileScriptReady ||
      !turnstileContainerRef.current ||
      !window.turnstile ||
      turnstileWidgetIdRef.current
    ) {
      return;
    }

    turnstileWidgetIdRef.current = window.turnstile.render(
      turnstileContainerRef.current,
      {
        sitekey: turnstileSiteKey,
        action: 'login',
        theme: currentTurnstileTheme,
        callback: (token: string) => { setTurnstileToken(token); setTurnstileError(false); },
        'expired-callback': () => { setTurnstileToken(''); setTurnstileError(false); },
        'error-callback': () => { setTurnstileToken(''); setTurnstileError(true); },
      },
    );

    return () => {
      if (turnstileWidgetIdRef.current && window.turnstile?.remove) {
        window.turnstile.remove(turnstileWidgetIdRef.current);
      }
      turnstileWidgetIdRef.current = null;
      setTurnstileToken('');
      setTurnstileError(false);
    };
  }, [currentTurnstileTheme, shouldRenderTurnstile, turnstileScriptReady, turnstileSiteKey]);

  const clearError = () => {
    if (error) setError('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!cpf || !password) {
      setError('Preencha todos os campos.');
      return;
    }

    if (shouldRenderTurnstile && !turnstileToken) {
      setError('Conclua a verificação de segurança antes de entrar.');
      return;
    }

    setLoading(true);
    const cleanCpf = cpf.replace(/\D/g, '');

    try {
      if (mfaStage === 'challenge') {
        const response = await authService.verifyLoginMfa(mfaChallengeToken, mfaCode);
        finalizeLogin(response);
        return;
      }

      if (mfaStage === 'bootstrap') {
        const response = await authService.activateBootstrapMfa(
          mfaChallengeToken,
          mfaCode,
        );
        finalizeLogin(response);
        return;
      }

      const result = await login(cleanCpf, password, turnstileToken || undefined);
      if ('mfaRequired' in result) {
        setMfaStage('challenge');
        setMfaChallengeToken(result.challengeToken);
        return;
      }

      if ('mfaEnrollRequired' in result) {
        setMfaStage('bootstrap');
        setMfaChallengeToken(result.challengeToken);
        setMfaOtpAuthUrl(result.otpAuthUrl || '');
        setMfaManualEntryKey(result.manualEntryKey || '');
        setMfaRecoveryCodes(Array.isArray(result.recoveryCodes) ? result.recoveryCodes : []);
        return;
      }
    } catch (err: unknown) {
      if (isAxiosError(err)) {
        const status = err.response?.status;
        if (status === 401) {
          setError('CPF, senha ou código MFA inválido.');
        } else if (status === 400) {
          setError('Dados inválidos. Verifique as informações e tente novamente.');
        } else if (status === 429) {
          setError('Muitas tentativas. Aguarde alguns minutos e tente novamente.');
        } else if (status === 503) {
          setError('Serviço temporariamente indisponível. Tente novamente em instantes.');
        } else {
          setError('Erro ao tentar entrar. Tente novamente.');
        }
      } else {
        setError('Erro ao tentar entrar. Tente novamente.');
      }

      if (turnstileWidgetIdRef.current && window.turnstile?.reset) {
        window.turnstile.reset(turnstileWidgetIdRef.current);
      }
      setTurnstileToken('');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.page}>
      {turnstileEnabled && (
        <Script
          src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
          nonce={nonce}
          strategy="afterInteractive"
          onLoad={() => setTurnstileScriptReady(true)}
        />
      )}

      <main id="main-content" className={styles.shell}>
        <div className={styles.card}>
          <section className={styles.brandBlock}>
            <div className={styles.brandRow}>
              <Image
                src="/logo-sgs.svg"
                alt="SGS - Sistema de Gestão de Segurança"
                width={260}
                height={130}
                className={styles.brandLogo}
                priority
              />
            </div>
          </section>

          <section className={styles.formSection}>
          <header className={styles.header}>
            <h1 className={styles.title}>Informe seus dados abaixo:</h1>
          </header>

          {sessionExpired ? (
            <div className={`${styles.noticeBanner} ${styles.infoBanner}`} role="status">
              <Shield size={16} aria-hidden="true" />
              <span>Sua sessão expirou. Faça login novamente para retomar o trabalho.</span>
            </div>
          ) : null}

          <form onSubmit={handleSubmit} className={styles.loginForm}>
            <div className={styles.formGroup}>
              <label className={styles.formLabel} htmlFor="cpf">
                CPF
              </label>
              <div className={styles.inputWrap}>
                <UserIcon size={18} className={styles.inputIcon} />
                <input
                  id="cpf"
                  type="text"
                  inputMode="numeric"
                  autoComplete="username"
                  autoFocus
                  required
                  className={styles.formInput}
                  placeholder="Informe seu CPF"
                  value={cpf}
                  onChange={(e) => {
                    clearError();
                    setCpf(formatCpfInput(e.target.value));
                  }}
                  disabled={loading}
                  aria-describedby={error ? 'login-error' : undefined}
                />
              </div>
            </div>

            <div className={styles.formGroup}>
              <label className={styles.formLabel} htmlFor="senha">
                Senha
              </label>
              <div className={styles.inputWrap}>
                <Lock size={18} className={styles.inputIcon} />
                <input
                  id="senha"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  required
                  className={styles.formInput}
                  placeholder="Informe sua senha"
                  value={password}
                  onChange={(e) => {
                    clearError();
                    setPassword(e.target.value);
                  }}
                  disabled={loading}
                  aria-describedby={error ? 'login-error' : undefined}
                />
                <button
                  type="button"
                  className={styles.eyeBtn}
                  onClick={() => setShowPassword((current) => !current)}
                  aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'}
                >
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>

            <div className={styles.metaRow}>
              <Link href="/forgot-password" className={styles.forgotLink}>
                Esqueci a senha
              </Link>
            </div>

            {mfaStage === 'bootstrap' ? (
              <div className={`${styles.noticeBanner} ${styles.infoBanner}`} role="status">
                <Shield size={16} aria-hidden="true" />
                <span>
                  Primeiro acesso com MFA obrigatório. Cadastre seu autenticador e informe
                  o código de 6 dígitos para concluir.
                </span>
              </div>
            ) : null}

            {mfaStage === 'bootstrap' && mfaManualEntryKey ? (
              <div className={styles.formGroup}>
                <label className={styles.formLabel} htmlFor="mfa-manual-key">
                  Chave manual (backup)
                </label>
                <input
                  id="mfa-manual-key"
                  type="text"
                  className={`${styles.formInput} ${styles.readOnlyField}`}
                  value={mfaManualEntryKey}
                  readOnly
                  aria-readonly="true"
                />
              </div>
            ) : null}

            {mfaStage === 'bootstrap' && mfaOtpAuthUrl ? (
              <div className={styles.mfaQrPanel}>
                <p className="sr-only">
                  Se não consegue escanear o QR code, use a chave manual exibida abaixo.
                </p>
                <QRCodeCanvas
                  value={mfaOtpAuthUrl}
                  size={184}
                  includeMargin
                  title="QR Code para cadastro MFA"
                  className={styles.mfaQrCode}
                />
              </div>
            ) : null}

            {mfaStage === 'bootstrap' && mfaRecoveryCodes.length > 0 ? (
              <RecoveryCodes codes={mfaRecoveryCodes} />
            ) : null}

            {mfaStage === 'bootstrap' && mfaOtpAuthUrl ? (
              <div className={styles.metaRow}>
                <a href={mfaOtpAuthUrl} className={styles.forgotLink}>
                  Abrir cadastro no app autenticador
                </a>
              </div>
            ) : null}

            {(mfaStage === 'challenge' || mfaStage === 'bootstrap') && (
              <div className={styles.formGroup}>
                <label className={styles.formLabel} htmlFor="mfa">
                  Código MFA
                </label>
                <div className={styles.inputWrap}>
                  <Shield size={18} className={styles.inputIcon} />
                  <input
                    id="mfa"
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    className={styles.formInput}
                    placeholder="000000"
                    value={mfaCode}
                    onChange={(e) => {
                      clearError();
                      setMfaCode(e.target.value.replace(/\D/g, '').slice(0, 6));
                    }}
                    disabled={loading}
                  />
                </div>
              </div>
            )}

            {error ? (
              <div
                id="login-error"
                className={`${styles.noticeBanner} ${styles.errorBanner}`}
                role="alert"
                aria-live="assertive"
              >
                <AlertCircle size={16} aria-hidden="true" />
                <span>{error}</span>
              </div>
            ) : null}

            {shouldRenderTurnstile ? (
              <div className={styles.turnstileWrap}>
                <div ref={turnstileContainerRef} />
                {turnstileError ? (
                  <div className={`${styles.noticeBanner} ${styles.errorBanner}`} role="alert">
                    <AlertCircle size={16} aria-hidden="true" />
                    <span>
                      Falha no verificador de segurança (Cloudflare).{' '}
                      <button
                        type="button"
                        onClick={resetTurnstile}
                        style={{ fontWeight: 700, textDecoration: 'underline', background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', padding: 0 }}
                      >
                        Tentar novamente
                      </button>
                      {' '}ou recarregue a página. VPN/proxy pode bloquear esta verificação.
                    </span>
                  </div>
                ) : null}
              </div>
            ) : null}

            <button
              className={styles.btnSubmit}
              type="submit"
              disabled={loading}
            >
              {loading ? (
                <span className={styles.loadingContent}>
                  <span className={styles.spinner} />
                  Entrando...
                </span>
              ) : mfaStage === 'bootstrap' ? (
                'Ativar MFA e entrar'
              ) : mfaStage === 'challenge' ? (
                'Confirmar acesso'
              ) : (
                'Acessar'
              )}
            </button>
          </form>

          <div className={styles.supportCta}>
            <a href={supportHref} className={styles.supportLink}>
              Precisa de ajuda para acessar?
            </a>
          </div>

          <div className={styles.securityNote}>
            <BadgeCheck size={14} aria-hidden="true" />
            <span>Acesso protegido e rastreável.</span>
          </div>

          <div className={styles.footerLinks}>
            <Link href="/termos" prefetch={false} className={styles.footerLink}>
              Termos de Uso
            </Link>
            <Link href="/privacidade" prefetch={false} className={styles.footerLink}>
              Política de Privacidade
            </Link>
          </div>
          {APP_VERSION ? (
            <p className={styles.version}>versão {APP_VERSION}</p>
          ) : null}
        </section>
        </div>
      </main>
    </div>
  );
}

function RecoveryCodes({ codes }: { codes: string[] }) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const timerRef = React.useRef<number | undefined>(undefined);

  React.useEffect(() => {
    return () => {
      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
      }
    };
  }, []);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(codes.join('\n'));
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
    }
    setCopied(true);
    timerRef.current = window.setTimeout(() => setCopied(false), 2500);
  };

  return (
    <div className={styles.formGroup}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <span className={styles.formLabel} style={{ margin: 0 }}>Códigos de recuperação</span>
        <button
          type="button"
          onClick={() => setRevealed((r) => !r)}
          aria-label={revealed ? 'Ocultar códigos' : 'Revelar códigos'}
          style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--color-text-secondary)' }}
        >
          {revealed ? <EyeOff size={14} /> : <Eye size={14} />}
          {revealed ? 'Ocultar' : 'Revelar'}
        </button>
      </div>

      <ul
        aria-label="Códigos de recuperação"
        aria-hidden={!revealed}
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 6,
          filter: revealed ? 'none' : 'blur(6px)',
          userSelect: 'none',
          pointerEvents: 'none',
          marginBottom: 8,
          listStyle: 'none',
          padding: 0,
          margin: '0 0 8px 0',
        }}
      >
        {codes.map((code, i) => (
          <li
            key={i}
            style={{
              fontFamily: 'monospace',
              fontSize: 13,
              padding: '4px 8px',
              borderRadius: 6,
              background: 'var(--color-card-muted, rgba(0,0,0,0.05))',
              letterSpacing: '0.05em',
            }}
          >
            {code}
          </li>
        ))}
      </ul>

      <p style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginBottom: 8 }}>
        Salve estes códigos em local seguro. Cada um pode ser usado uma vez para recuperar o acesso se perder o autenticador.
      </p>

      <button
        type="button"
        onClick={handleCopy}
        disabled={!revealed}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 13,
          fontWeight: 600,
          padding: '8px 14px',
          borderRadius: 10,
          border: '1px solid var(--color-border-subtle)',
          background: 'transparent',
          cursor: revealed ? 'pointer' : 'not-allowed',
          opacity: revealed ? 1 : 0.5,
          color: 'var(--color-text)',
        }}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
        {copied ? 'Copiado!' : 'Copiar todos os códigos'}
      </button>
    </div>
  );
}

function LoginFallback() {
  return <div className={styles.fallback} />;
}

export default function LoginPageClient(props: LoginPageClientProps) {
  return (
    <Suspense fallback={<LoginFallback />}>
      <LoginPageContent {...props} />
    </Suspense>
  );
}

