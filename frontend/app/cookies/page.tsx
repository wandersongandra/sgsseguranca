import type { Metadata } from 'next';
import Link from 'next/link';
import {
  ArrowLeft,
  BadgeCheck,
  Cookie,
  LockKeyhole,
  ShieldCheck,
} from 'lucide-react';
import { getPublicLegalConfig } from '@/lib/legal';
import styles from '../legal-pages.module.css';

export const metadata: Metadata = {
  title: 'Política de Cookies | SGS',
  description:
    'Política de cookies e tecnologias semelhantes da plataforma SGS.',
};

type CookieCategory = 'Estritamente necessário' | 'Funcional';

interface CookieRow {
  name: string;
  category: CookieCategory;
  purpose: string;
  duration: string;
  thirdParty: string;
  httpOnly: boolean;
  secure: boolean;
}

const cookies: CookieRow[] = [
  {
    name: 'refresh_token',
    category: 'Estritamente necessário',
    purpose: 'Refresh token JWT — permite renovar a sessão sem nova autenticação. O access token é retornado via JSON e mantido em memória, não em cookie. HttpOnly, SameSite=Strict, path=/auth/refresh.',
    duration: '30 dias (renovável)',
    thirdParty: 'Não',
    httpOnly: true,
    secure: true,
  },
  {
    name: 'refresh_csrf',
    category: 'Estritamente necessário',
    purpose: 'Token CSRF dedicado ao endpoint de renovação de sessão (/auth/refresh). Previne ataques CSRF na troca do refresh token.',
    duration: '30 dias',
    thirdParty: 'Não',
    httpOnly: false,
    secure: true,
  },
  {
    name: 'csrf-token',
    category: 'Estritamente necessário',
    purpose: 'Token HMAC-SHA256 de proteção contra Cross-Site Request Forgery. Validado em todas as operações de escrita (POST, PUT, PATCH, DELETE).',
    duration: 'Sessão',
    thirdParty: 'Não',
    httpOnly: false,
    secure: true,
  },
  {
    name: '__cf_bm',
    category: 'Estritamente necessário',
    purpose: 'Cookie de mitigação de bots da Cloudflare. Distingue visitantes humanos de tráfego automatizado.',
    duration: '30 minutos',
    thirdParty: 'Cloudflare (EUA)',
    httpOnly: false,
    secure: true,
  },
  {
    name: 'cf_clearance',
    category: 'Estritamente necessário',
    purpose: 'Prova de resolução de desafio Cloudflare. Necessário quando um desafio de segurança é apresentado.',
    duration: '30 minutos a 24 horas',
    thirdParty: 'Cloudflare (EUA)',
    httpOnly: false,
    secure: true,
  },
  {
    name: 'sgs_company_id',
    category: 'Estritamente necessário',
    purpose: 'Identifica a empresa ativa na sessão multi-tenant. Garante isolamento de dados entre organizações.',
    duration: 'Sessão',
    thirdParty: 'Não',
    httpOnly: true,
    secure: true,
  },
  {
    name: 'sgs_consent_ack',
    category: 'Funcional',
    purpose: 'Registra localmente se o modal de consentimento de primeiro acesso foi exibido neste dispositivo.',
    duration: '90 dias',
    thirdParty: 'Não',
    httpOnly: false,
    secure: true,
  },
];

const categoryDescriptions: Record<CookieCategory, string> = {
  'Estritamente necessário':
    'Indispensáveis para o funcionamento da plataforma. Não podem ser desativados pois são essenciais à autenticação, segurança da sessão e isolamento de dados. Não armazenam informação de identificação pessoal além do necessário para a sessão.',
  Funcional:
    'Melhoram a experiência de uso e armazenam preferências. Podem ser recusados sem impactar funções essenciais da plataforma.',
};

const grouped = cookies.reduce<Record<CookieCategory, CookieRow[]>>(
  (acc, c) => {
    if (!acc[c.category]) acc[c.category] = [];
    acc[c.category].push(c);
    return acc;
  },
  {} as Record<CookieCategory, CookieRow[]>,
);

export default function CookiesPage() {
  const legal = getPublicLegalConfig();
  const lastUpdated = legal.policyVersion || '—';
  const privacyHref = legal.privacyEmail ? `mailto:${legal.privacyEmail}` : null;
  const privacyChannel = legal.privacyEmail || 'canal de privacidade';

  return (
    <div className={`${styles.page} ${styles.privacyPage}`}>
      <div className={`${styles.ambientGlow} ${styles.privacyAmbientGlow}`} />
      <div className={`${styles.ambientGlowSecondary} ${styles.privacyAmbientGlowSecondary}`} />

      <div className={styles.shell}>
        <Link href="/login" className={styles.backLink}>
          <ArrowLeft size={16} />
          Voltar ao login
        </Link>

        <section className={`${styles.hero} ${styles.privacyHero}`}>
          <div className={`${styles.heroBadge} ${styles.privacyHeroBadge}`}>
            <Cookie size={14} />
            Transparência sobre cookies e tecnologias de sessão
          </div>

          <div className={`${styles.heroGrid} ${styles.privacyHeroGrid}`}>
            <div className={`${styles.heroMain} ${styles.privacyHeroMain}`}>
              <h1 className={`${styles.heroTitle} ${styles.privacyHeroTitle}`}>
                Política de Cookies
              </h1>
              <p className={`${styles.heroDescription} ${styles.privacyHeroDescription}`}>
                O SGS utiliza apenas cookies estritamente necessários para autenticação,
                segurança e continuidade de sessão. Não utilizamos cookies de rastreamento,
                publicidade ou analytics de terceiros.
              </p>

              <div className={styles.heroMeta}>
                <span className={`${styles.metaPill} ${styles.privacyMetaPill}`}>
                  <BadgeCheck size={14} />
                  Versão: {lastUpdated}
                </span>
                <span className={`${styles.metaPill} ${styles.privacyMetaPill}`}>
                  <ShieldCheck size={14} />
                  Somente cookies essenciais
                </span>
                <span className={`${styles.metaPill} ${styles.privacyMetaPill}`}>
                  <LockKeyhole size={14} />
                  Sem rastreamento publicitário
                </span>
              </div>
            </div>

            <aside className={`${styles.heroPanel} ${styles.privacyHeroPanel}`}>
              <p className={styles.panelEyebrow}>Resumo</p>
              <h2 className={styles.panelTitle}>O que usamos e por quê</h2>
              <div className={styles.sideList}>
                <div className={styles.sideItem}>
                  <span className={styles.sideIcon}>
                    <LockKeyhole size={18} />
                  </span>
                  <div>
                    <strong>Autenticação e sessão</strong>
                    <p>Tokens de autenticação para manter você logado com segurança.</p>
                  </div>
                </div>
                <div className={styles.sideItem}>
                  <span className={styles.sideIcon}>
                    <ShieldCheck size={18} />
                  </span>
                  <div>
                    <strong>Proteção de segurança</strong>
                    <p>Cloudflare para proteção contra bots e ataques CSRF.</p>
                  </div>
                </div>
                <div className={styles.sideItem}>
                  <span className={styles.sideIcon}>
                    <Cookie size={18} />
                  </span>
                  <div>
                    <strong>Nenhum cookie de marketing</strong>
                    <p>Não rastreamos você para fins publicitários ou de analytics de terceiros.</p>
                  </div>
                </div>
              </div>
            </aside>
          </div>
        </section>

        <div className={styles.content}>
          <section className={styles.section}>
            <h2>1. O que são cookies</h2>
            <p>
              Cookies são pequenos arquivos de texto armazenados no seu navegador quando
              você visita um site. São utilizados para manter sessões, preferências e
              segurança da plataforma.
            </p>
            <p>
              O SGS é uma plataforma de uso corporativo (B2B). Os cookies que utilizamos
              são técnicos e necessários para o funcionamento seguro da aplicação —
              não há cookies de marketing, rastreamento comportamental ou redes
              publicitárias de terceiros.
            </p>
          </section>

          <section className={styles.section}>
            <h2>2. Categorias de cookies utilizados</h2>

            {(Object.keys(grouped) as CookieCategory[]).map((category) => (
              <div key={category} style={{ marginBottom: '2rem' }}>
                <h3>{category}</h3>
                <p className={styles.callout}>{categoryDescriptions[category]}</p>

                <div className={styles.tableWrap}>
                  <table className={styles.dataTable}>
                    <thead>
                      <tr>
                        <th>Nome</th>
                        <th>Finalidade</th>
                        <th>Duração</th>
                        <th>Terceiro</th>
                        <th>HttpOnly</th>
                        <th>Secure</th>
                      </tr>
                    </thead>
                    <tbody>
                      {grouped[category].map((c) => (
                        <tr key={c.name}>
                          <td><code>{c.name}</code></td>
                          <td>{c.purpose}</td>
                          <td>{c.duration}</td>
                          <td>{c.thirdParty}</td>
                          <td>{c.httpOnly ? 'Sim' : 'Não'}</td>
                          <td>{c.secure ? 'Sim' : 'Não'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </section>

          <section className={styles.section}>
            <h2>3. Cookies de terceiros</h2>
            <p>
              O SGS utiliza cookies de dois terceiros:
            </p>
            <ul className={styles.bulletList}>
              <li>
                <strong>Cloudflare (EUA):</strong> cookies <code>__cf_bm</code> e{' '}
                <code>cf_clearance</code> para proteção DDoS, WAF e mitigação de bots.
                A base contratual, DPA e cláusulas de transferência devem ser
                confirmadas conforme a configuração e o contrato vigentes. Saiba mais em{' '}
                <a
                  href="https://www.cloudflare.com/privacypolicy/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className={styles.inlineLink}
                >
                  cloudflare.com/privacypolicy
                </a>
                .
              </li>
              <li>
                <strong>Neon (PostgreSQL):</strong> banco de dados relacional que
                armazena sessões e dados de autenticação. DPA, região e certificações
                aplicáveis devem ser confirmados conforme o serviço contratado.
                Saiba mais em{' '}
                <a
                  href="https://neon.tech/privacy"
                  target="_blank"
                  rel="noopener noreferrer"
                  className={styles.inlineLink}
                >
                  neon.tech/privacy
                </a>
                .
              </li>
            </ul>
          </section>

          <section className={styles.section}>
            <h2>4. Controle e configuração</h2>
            <p>
              Como todos os cookies do SGS são estritamente necessários (com exceção do
              cookie funcional <code>sgs_consent_ack</code>), não há painel de
              consentimento granular por categoria — a desativação dos cookies essenciais
              impede o funcionamento da plataforma.
            </p>
            <p>
              Você pode gerenciar ou excluir cookies nas configurações do seu navegador:
            </p>
            <ul className={styles.bulletList}>
              <li>
                <strong>Chrome:</strong> Configurações → Privacidade e segurança → Cookies
              </li>
              <li>
                <strong>Firefox:</strong> Configurações → Privacidade e Segurança → Cookies
              </li>
              <li>
                <strong>Safari:</strong> Preferências → Privacidade → Gerenciar dados de sites
              </li>
              <li>
                <strong>Edge:</strong> Configurações → Privacidade, pesquisa e serviços → Cookies
              </li>
            </ul>
            <p className={styles.callout}>
              A exclusão de cookies de sessão causará o encerramento imediato da sua
              sessão autenticada. Você precisará fazer login novamente.
            </p>
          </section>

          <section className={styles.section}>
            <h2>5. Armazenamento local (localStorage / sessionStorage)</h2>
            <p>
              Além de cookies, o SGS pode utilizar <code>localStorage</code> e{' '}
              <code>sessionStorage</code> para:
            </p>
            <ul className={styles.bulletList}>
              <li>Preferências de interface (tema, layout de tabelas) — armazenadas localmente no dispositivo.</li>
              <li>Estado temporário de formulários não submetidos — limpos ao fechar a aba.</li>
              <li>Cache de dados de sessão para reduzir latência de carregamento.</li>
            </ul>
            <p>
              Esses dados ficam no dispositivo para continuidade de uso. Filas offline,
              quando habilitadas, podem ser sincronizadas posteriormente com o SGS após
              autenticação; dados sensíveis devem ser minimizados nesses recursos.
            </p>
          </section>

          <section className={styles.section}>
            <h2>6. Atualizações desta política</h2>
            <p>
              Esta política pode ser atualizada para refletir mudanças na plataforma,
              em provedores de segurança ou na legislação aplicável. A versão vigente é
              identificada pelo número de versão no cabeçalho desta página (versão{' '}
              {lastUpdated}).
            </p>
          </section>

          <section className={styles.section}>
            <h2>7. Contato</h2>
            <p>
              Dúvidas sobre cookies ou privacidade podem ser enviadas para{' '}
              {privacyHref ? (
                <a href={privacyHref} className={styles.inlineLink}>
                  {privacyChannel}
                </a>
              ) : (
                privacyChannel
              )}
              .
            </p>
          </section>
        </div>

        <div className={styles.footerNav}>
          <Link href="/login">Login</Link>
          <Link href="/privacidade">Política de Privacidade</Link>
          <Link href="/termos">Termos de Uso</Link>
        </div>

        <p className={styles.footnote}>
          Esta política de cookies complementa a{' '}
          <Link href="/privacidade" className={styles.inlineLink}>
            Política de Privacidade
          </Link>{' '}
          (versão {lastUpdated}).
        </p>
      </div>
    </div>
  );
}
