'use client';

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Script from 'next/script';
import Image from 'next/image';
import { AlertCircle, CheckCircle } from 'lucide-react';
import api from '@/lib/api';
import { formatCpfInput } from '@/lib/format/cpf';
import axios from 'axios';
import styles from '../auth.module.css';

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

function getBodyNonce(): string | undefined {
  if (typeof document === 'undefined') return undefined;
  return document.body?.getAttribute('data-nonce') || undefined;
}

export default function ForgotPasswordPage() {
  const router = useRouter();
  const [cpf, setCpf] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  const turnstileSiteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim() || '';
  const turnstileEnabled = turnstileSiteKey.length > 0;
  const [turnstileToken, setTurnstileToken] = useState('');
  const [turnstileScriptReady, setTurnstileScriptReady] = useState(false);
  const turnstileContainerRef = useRef<HTMLDivElement>(null);
  const turnstileWidgetIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (
      !turnstileEnabled ||
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
        action: 'forgot-password',
        callback: (token: string) => setTurnstileToken(token),
        'expired-callback': () => setTurnstileToken(''),
        'error-callback': () => setTurnstileToken(''),
      },
    );

    return () => {
      if (turnstileWidgetIdRef.current && window.turnstile?.remove) {
        window.turnstile.remove(turnstileWidgetIdRef.current);
      }
      turnstileWidgetIdRef.current = null;
      setTurnstileToken('');
    };
  }, [turnstileEnabled, turnstileScriptReady, turnstileSiteKey]);

  const resetTurnstile = () => {
    if (turnstileWidgetIdRef.current && window.turnstile?.reset) {
      window.turnstile.reset(turnstileWidgetIdRef.current);
    }
    setTurnstileToken('');
  };

  const handleCpfChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (error) setError('');
    setCpf(formatCpfInput(e.target.value));
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError('');

    if (turnstileEnabled && !turnstileToken) {
      setError('Conclua a verificação de segurança antes de continuar.');
      return;
    }

    setLoading(true);
    try {
      await api.post('/auth/forgot-password', {
        cpf: cpf.replace(/\D/g, ''),
        turnstileToken: turnstileToken || undefined,
      });
      setSent(true);
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 429) {
        setError('Muitas tentativas. Aguarde alguns minutos e tente novamente.');
      } else {
        setError('Ocorreu um erro. Tente novamente mais tarde.');
      }
      resetTurnstile();
    } finally {
      setLoading(false);
    }
  };

  const nonce = getBodyNonce();

  return (
    <main id="main-content" className={styles.page}>
      {turnstileEnabled && (
        <Script
          src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
          nonce={nonce}
          strategy="afterInteractive"
          onLoad={() => setTurnstileScriptReady(true)}
        />
      )}

      <div className={styles.card}>
        <div className={styles.brand}>
          <Image
            src="/logo-sgs.svg"
            alt="SGS - Sistema de Gestão de Segurança"
            width={72}
            height={102}
            priority
            className={styles.brandLogo}
          />
          <p className={styles.brandCaption}>Sistema de Gestão de Segurança</p>
        </div>

        {sent ? (
          <div className="space-y-4">
            <div className={styles.successBanner} role="status">
              <CheckCircle size={32} className={styles.successIcon} aria-hidden="true" />
              <p className={styles.successTitle}>Solicitação enviada</p>
              <p className={styles.successText}>
                Se o CPF estiver cadastrado, você receberá um e-mail com o link para redefinir sua senha. Verifique também sua caixa de spam.
              </p>
            </div>
            <button
              type="button"
              onClick={() => router.push('/login')}
              className={styles.submitButton}
            >
              Voltar para o login
            </button>
          </div>
        ) : (
          <>
            <div className={styles.header}>
              <h1 className={styles.title}>Recuperação de senha</h1>
              <p className={styles.subtitle}>Informe seu CPF para receber as instruções por e-mail</p>
            </div>

            <form onSubmit={handleSubmit} className={styles.form}>
              <div className={styles.field}>
                <label htmlFor="cpf" className={styles.label}>CPF</label>
                <input
                  id="cpf"
                  type="text"
                  inputMode="numeric"
                  value={cpf}
                  onChange={handleCpfChange}
                  className={styles.input}
                  placeholder="000.000.000-00"
                  required
                  autoFocus
                  aria-label="CPF do usuário"
                />
              </div>

              {error && (
                <div className={styles.errorBanner} role="alert" aria-live="assertive">
                  <AlertCircle size={16} aria-hidden="true" />
                  <span>{error}</span>
                </div>
              )}

              {turnstileEnabled ? (
                <div style={{ display: 'flex', justifyContent: 'center' }}>
                  <div ref={turnstileContainerRef} />
                </div>
              ) : null}

              <button
                type="submit"
                disabled={loading || (turnstileEnabled && !turnstileToken)}
                className={styles.submitButton}
              >
                {loading ? (
                  <span className={styles.loadingState}>
                    <span className={styles.loadingDot} />
                    Enviando...
                  </span>
                ) : (
                  'Enviar instruções'
                )}
              </button>

              <button
                type="button"
                onClick={() => router.push('/login')}
                className={styles.backLink}
              >
                Voltar para o login
              </button>
            </form>
          </>
        )}
      </div>
    </main>
  );
}
