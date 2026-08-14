import type { Metadata } from 'next';
import Link from 'next/link';
import {
  ArrowLeft,
  BadgeCheck,
  ChevronRight,
  Database,
  LockKeyhole,
  ShieldCheck,
  UserRoundCheck,
  FileCheck2,
  Fingerprint,
  Globe2,
  Scale,
  Sparkles,
} from 'lucide-react';
import { getPublicLegalConfig } from '@/lib/legal';
import styles from '../legal-pages.module.css';

export const metadata: Metadata = {
  title: 'Política de Privacidade | SGS',
  description:
    'Política de privacidade e tratamento de dados pessoais do SGS - Sistema de Gestão de Segurança.',
};

type PurposeRow = readonly [purpose: string, legalBasis: string];

type SubprocessorRow = Readonly<{
  name: string;
  status: 'Ativo' | 'Condicional' | 'Opcional' | 'A confirmar';
  purpose: string;
  country: string;
  safeguard: string;
}>;

type CookieRow = Readonly<{
  name: string;
  type: string;
  purpose: string;
  duration: string;
  thirdParty: string;
}>;

type RetentionRow = Readonly<{
  context: string;
  period: string;
  basis: string;
}>;

const purposeRows = [
  [
    'Autenticação, segurança da conta e prevenção a fraude',
    'Execução do contrato (art. 7º, V), legítimo interesse (art. 7º, IX) e, quando houver dado sensível de autenticação, prevenção à fraude e segurança do titular (art. 11, II, “g”)',
  ],
  [
    'Gestão de documentos, treinamentos, evidências e rotinas de SST',
    'Execução do contrato (art. 7º, V) e cumprimento de obrigação legal ou regulatória pelo controlador (art. 7º, II)',
  ],
  [
    'Exames, laudos, atestados e demais dados de saúde ocupacional',
    'Cumprimento de obrigação legal ou regulatória pelo controlador (art. 11, II, “a”) e exercício regular de direitos, inclusive em contrato (art. 11, II, “d”); tutela da saúde (art. 11, II, “f”) somente quando aplicável ao agente e ao contexto do tratamento',
  ],
  [
    'Trilha de auditoria, logs, prevenção e apuração de incidentes',
    'Legítimo interesse (art. 7º, IX), exercício regular de direitos (art. 7º, VI) e cumprimento de obrigações legais ou regulatórias, conforme o caso',
  ],
  [
    'Atendimento, suporte e continuidade do serviço',
    'Execução do contrato (art. 7º, V) e legítimo interesse (art. 7º, IX)',
  ],
  [
    'Faturamento, relacionamento comercial e comunicações institucionais',
    'Execução do contrato (art. 7º, V), cumprimento de obrigação legal (art. 7º, II) e legítimo interesse (art. 7º, IX), conforme a finalidade',
  ],
  [
    'Funcionalidades opcionais de inteligência artificial',
    'Base legal definida pelo controlador conforme a finalidade, o tipo de dado e o contexto. Dados sensíveis somente podem ser tratados nas hipóteses do art. 11 e com salvaguardas adicionais',
  ],
] satisfies readonly PurposeRow[];

const dataCategories = [
  'Dados cadastrais e profissionais: nome, CPF, e-mail, telefone, cargo, matrícula e identificadores internos.',
  'Credenciais e sinais de segurança: hash de senha, tokens, dados de autenticação multifator, dispositivo e eventos de sessão. O SGS não armazena senhas em texto puro.',
  'Registros operacionais de SST: treinamentos, APRs, PTAs, checklists, CATs, documentos, assinaturas e evidências fotográficas.',
  'Dados de saúde ocupacional, quando inseridos pelo Cliente: exames, laudos, atestados e resultados de avaliações, classificados como dados pessoais sensíveis.',
  'Registros técnicos: endereço IP, User-Agent, data e hora, identificadores de requisição, eventos de auditoria e informações necessárias à prevenção de abuso.',
  'Dados de suporte e relacionamento: chamados, mensagens, e-mails e informações comerciais relacionadas ao uso da plataforma.',
  'Conteúdo utilizado em recursos de IA, quando habilitados: perguntas, respostas, arquivos ou imagens enviados pelo usuário, limitados ao necessário para a funcionalidade e sujeitos às configurações do Cliente.',
] as const;

const subprocessors = [
  {
    name: 'Neon / PostgreSQL',
    status: 'Ativo',
    purpose: 'Banco de dados relacional para dados operacionais, usuários, auditoria e metadados de documentos.',
    country: 'Conforme a região contratada',
    safeguard: 'Criptografia em trânsito e em repouso conforme o serviço. DPA, região, backups e retenção devem corresponder ao contrato e à configuração de produção.',
  },
  {
    name: 'Backblaze B2',
    status: 'Ativo',
    purpose: 'Armazenamento de documentos, evidências, PDFs, backups e objetos por API compatível com S3.',
    country: 'Conforme a região contratada',
    safeguard: 'TLS, controles de acesso, política de retenção e DPA compatíveis com a categoria dos dados armazenados.',
  },
  {
    name: 'OpenAI',
    status: 'Condicional',
    purpose: 'Processamento de linguagem e, quando expressamente habilitado, análise de imagens em funcionalidades de IA da Sophie.',
    country: 'Conforme a região e o produto contratados',
    safeguard: 'Envio limitado ao conteúdo necessário; configurações de retenção, DPA e mecanismo de transferência internacional devem ser validados antes do uso em produção.',
  },
  {
    name: 'NVIDIA NIM',
    status: 'Opcional',
    purpose: 'Provedor alternativo para inferência de modelos de IA, conforme configuração do Cliente e disponibilidade técnica.',
    country: 'Conforme a região de processamento contratada',
    safeguard: 'Minimização, controle de finalidade, DPA e mecanismo válido de transferência internacional quando houver processamento fora do Brasil.',
  },
  {
    name: 'Anthropic',
    status: 'Opcional',
    purpose: 'Raciocínio e geração de linguagem natural em funcionalidades de IA, quando habilitadas.',
    country: 'Conforme a região e o produto contratados',
    safeguard: 'Minimização, DPA, configurações de retenção e mecanismo válido de transferência internacional.',
  },
  {
    name: 'Cloudflare',
    status: 'Condicional',
    purpose: 'CDN, proteção contra DDoS, WAF e mitigação de bots, quando habilitados.',
    country: 'Global',
    safeguard: 'Escopo, logs, DPA e transferência internacional devem refletir os produtos efetivamente habilitados.',
  },
  {
    name: 'Sentry',
    status: 'Opcional',
    purpose: 'Monitoramento de erros e desempenho da aplicação.',
    country: 'Conforme a região contratada',
    safeguard: 'Remoção ou mascaramento de dados pessoais, amostragem mínima, retenção limitada e DPA.',
  },
  {
    name: 'New Relic',
    status: 'Opcional',
    purpose: 'Observabilidade, métricas e rastreamento de desempenho.',
    country: 'Conforme a região contratada',
    safeguard: 'Mascaramento de atributos, exclusão de conteúdo sensível, retenção limitada e DPA.',
  },
  {
    name: 'Provedor de e-mail transacional',
    status: 'A confirmar',
    purpose: 'Envio de notificações operacionais, redefinição de senha e alertas.',
    country: 'Conforme o fornecedor contratado',
    safeguard: 'DPA, região, autenticação de domínio e retenção devem ser confirmados antes da publicação definitiva.',
  },
  {
    name: 'Redis / BullMQ',
    status: 'Ativo',
    purpose: 'Cache, controle de sessão, filas e processamento assíncrono.',
    country: 'Conforme o provedor e a região contratados',
    safeguard: 'TTL, criptografia, isolamento de rede, autenticação e política de persistência compatíveis com a finalidade.',
  },
] satisfies readonly SubprocessorRow[];

const cookieRows = [
  {
    name: 'refresh_token',
    type: 'Estritamente necessário',
    purpose: 'Permite renovar a sessão sem nova autenticação. Deve ser configurado como HttpOnly, Secure em produção, SameSite=Strict e restrito ao caminho de renovação.',
    duration: 'Até 30 dias, conforme a política de sessão',
    thirdParty: 'Não',
  },
  {
    name: 'refresh_csrf',
    type: 'Estritamente necessário',
    purpose: 'Token dedicado à proteção contra CSRF no fluxo de renovação de sessão.',
    duration: 'Até 30 dias',
    thirdParty: 'Não',
  },
  {
    name: 'csrf-token',
    type: 'Estritamente necessário',
    purpose: 'Proteção contra Cross-Site Request Forgery nas operações de escrita.',
    duration: 'Sessão',
    thirdParty: 'Não',
  },
  {
    name: '__cf_bm',
    type: 'Estritamente necessário quando habilitado',
    purpose: 'Mitigação de bots e proteção de borda da Cloudflare.',
    duration: 'Conforme configuração da Cloudflare',
    thirdParty: 'Cloudflare',
  },
  {
    name: 'sgs_company_id',
    type: 'Estritamente necessário',
    purpose: 'Mantém o contexto da organização selecionada. A autorização e o isolamento do tenant são sempre validados no servidor e não dependem exclusivamente deste cookie.',
    duration: 'Sessão',
    thirdParty: 'Não',
  },
  {
    name: 'sgs_consent_ack',
    type: 'Funcional',
    purpose: 'Registra localmente que o aviso de privacidade ou consentimento já foi apresentado.',
    duration: 'Até 90 dias',
    thirdParty: 'Não',
  },
] satisfies readonly CookieRow[];

const securityMeasures = [
  'Criptografia em trânsito por TLS e criptografia em repouso conforme os recursos dos provedores e a configuração de produção.',
  'Sessões protegidas, cookies HttpOnly/Secure/SameSite, autenticação multifator quando habilitada e validação de autorização no servidor.',
  'Isolamento multi-tenant por controles de aplicação e Row Level Security (RLS), sem confiar apenas em identificadores enviados pelo navegador.',
  'Trilhas de auditoria com controles de acesso e integridade, monitoramento, rate limiting e proteção de borda quando habilitada.',
  'Privilégio mínimo, segregação de ambientes, gestão de segredos, backups testados e procedimentos de continuidade e recuperação.',
  'Processo de resposta a incidentes com contenção, preservação de evidências, avaliação de risco e comunicação aos agentes competentes.',
] as const;

const rightsList = [
  'Confirmação da existência de tratamento e acesso aos dados pessoais (Art. 18, I e II).',
  'Correção de dados incompletos, inexatos ou desatualizados (Art. 18, III).',
  'Anonimização, bloqueio ou eliminação de dados desnecessários, excessivos ou tratados sem base legal (Art. 18, IV).',
  'Portabilidade a outro fornecedor, observados segredo comercial e requisitos técnicos aplicáveis (Art. 18, V).',
  'Eliminação dos dados tratados com base no consentimento (Art. 18, VI).',
  'Informação sobre compartilhamentos, bases legais e consequências de eventual negativa (Art. 18, VII e VIII).',
  'Revogação do consentimento e oposição, nas hipóteses admitidas pela LGPD (Art. 18, IX e §2º).',
  'Revisão de decisões automatizadas relevantes que afetem interesses do titular (Art. 20).',
];

const retentionRows = [
  { context: 'Conta e cadastro ativos', period: 'Durante o vínculo contratual e pelo prazo necessário às obrigações aplicáveis', basis: 'Execução do contrato e obrigação legal' },
  { context: 'Logs de auditoria e segurança', period: 'Prazo definido na matriz de retenção, considerando risco, contrato e obrigações legais', basis: 'Legítimo interesse, exercício regular de direitos e obrigação legal' },
  { context: 'Registro de incidentes de segurança', period: 'Mínimo de 5 anos a partir do registro, salvo obrigação superior', basis: 'Regulamentação da ANPD' },
  { context: 'Interações com IA', period: 'Pelo menor prazo necessário à funcionalidade e conforme configuração contratual do provedor', basis: 'Base legal aplicável à finalidade e ao tipo de dado' },
  { context: 'Notificações e e-mails transacionais', period: 'Conforme necessidade operacional, comprovação de envio e obrigação aplicável', basis: 'Execução do contrato e legítimo interesse' },
  { context: 'Identificadores de sessão e revogação', period: 'Até 30 dias após expiração, conforme arquitetura de autenticação', basis: 'Execução do contrato e segurança' },
  { context: 'Documentos e evidências de SST', period: 'Conforme legislação aplicável, contrato e instrução do controlador', basis: 'Cumprimento de obrigação legal e exercício regular de direitos' },
  { context: 'Dados após o término do contrato', period: 'Janela de exportação de até 30 dias; eliminação, bloqueio ou anonimização subsequente, ressalvadas retenções obrigatórias e ciclos de backup', basis: 'Execução do contrato e obrigação legal' },
] satisfies readonly RetentionRow[];

const quickLinks = [
  { id: 'escopo', label: 'Escopo e agentes' },
  { id: 'dados', label: 'Dados tratados' },
  { id: 'saude', label: 'Dados de saúde' },
  { id: 'bases', label: 'Finalidades e bases legais' },
  { id: 'compartilhamento', label: 'Suboperadores' },
  { id: 'transferencias', label: 'Transferências internacionais' },
  { id: 'retencao', label: 'Retenção' },
  { id: 'cookies', label: 'Cookies' },
  { id: 'direitos', label: 'Direitos dos titulares' },
  { id: 'seguranca', label: 'Segurança e incidentes' },
  { id: 'contato', label: 'DPO e contato' },
];

export default function PrivacidadePage() {
  const legal = getPublicLegalConfig();
  const lastUpdated = legal.policyVersion || '—';
  const companyName =
    legal.companyName || 'a operadora identificada no instrumento contratual aplicável';
  const companyDocument = legal.companyDocument
    ? `, inscrita no CPF/CNPJ ${legal.companyDocument}`
    : '';
  const companyAddress =
    legal.companyAddress || 'endereço informado no contrato comercial vigente';
  const privacyChannel =
    legal.privacyEmail ||
    'canal de privacidade informado ao administrador da organização';
  const privacyHref = legal.privacyEmail ? `mailto:${legal.privacyEmail}` : null;
  const supportChannel = legal.supportEmail;
  const supportHref = legal.supportEmail ? `mailto:${legal.supportEmail}` : null;
  const showDedicatedSupportChannel =
    Boolean(supportChannel) && supportChannel !== legal.privacyEmail;
  const dpoLabel = legal.dpoName || 'Encarregado pelo tratamento de dados pessoais';
  const dpoEmail = legal.dpoEmail;
  const dpoPhone = legal.dpoPhone;
  const hasMissingLegalInfo = legal.missingRequiredFields.length > 0;

  return (
    <div className={`${styles.page} ${styles.privacyPage}`}>
      <div className={`${styles.ambientGlow} ${styles.privacyAmbientGlow}`} aria-hidden="true" />
      <div
        className={`${styles.ambientGlowSecondary} ${styles.privacyAmbientGlowSecondary}`}
        aria-hidden="true"
      />

      <div className={styles.shell}>
        <Link href="/login" className={styles.backLink}>
          <ArrowLeft size={16} aria-hidden="true" />
          Voltar ao login
        </Link>

        <section
          className={`${styles.hero} ${styles.privacyHero}`}
          aria-labelledby="privacy-policy-title"
        >
          <div className={`${styles.heroBadge} ${styles.privacyHeroBadge}`}>
            <Sparkles size={14} />
            Privacidade, segurança e governança de dados
          </div>

          <div className={`${styles.heroGrid} ${styles.privacyHeroGrid}`}>
            <div className={`${styles.heroMain} ${styles.privacyHeroMain}`}>
              <h1
                id="privacy-policy-title"
                className={`${styles.heroTitle} ${styles.privacyHeroTitle}`}
              >
                Política de Privacidade
              </h1>
              <p className={`${styles.heroDescription} ${styles.privacyHeroDescription}`}>
                Transparência, rastreabilidade e proteção de dados em padrão corporativo.
                Esta política explica como o SGS trata dados pessoais dentro da
                plataforma, com foco em conformidade com a LGPD, segurança operacional e
                confiança institucional.
              </p>

              <div className={styles.heroMeta}>
                <span className={`${styles.metaPill} ${styles.privacyMetaPill}`}>
                  <BadgeCheck size={14} />
                  Versão: {lastUpdated}
                </span>
                <span className={`${styles.metaPill} ${styles.privacyMetaPill}`}>
                  <Database size={14} />
                  Dados operacionais, cadastrais e auditoráveis
                </span>
                <span className={`${styles.metaPill} ${styles.privacyMetaPill}`}>
                  <ShieldCheck size={14} />
                  Transparência orientada pela LGPD
                </span>
              </div>

              <div className={styles.heroActions}>
                <a href="#escopo" className={styles.primaryButton}>
                  Ler política
                  <ChevronRight size={16} />
                </a>
                <a href="#contato" className={styles.secondaryButton}>
                  Canal de privacidade
                </a>
              </div>
            </div>

            <aside className={`${styles.heroPanel} ${styles.privacyHeroPanel}`}>
              <p className={styles.panelEyebrow}>Visão executiva</p>
              <h2 className={styles.panelTitle}>Governança de privacidade para ambiente corporativo</h2>
              <p className={styles.panelText}>
                A operação do SGS organiza o tratamento de dados com clareza de papéis, bases legais,
                rastreabilidade, retenção e resposta a incidentes.
              </p>

              <div className={styles.sideList}>
                <div className={styles.sideItem}>
                  <span className={styles.sideIcon}>
                    <UserRoundCheck size={18} />
                  </span>
                  <div>
                    <strong>Quando atuamos como controladores</strong>
                    <p>
                      Dados institucionais, relacionamento comercial, faturamento,
                      segurança da plataforma e obrigações próprias.
                    </p>
                  </div>
                </div>

                <div className={styles.sideItem}>
                  <span className={styles.sideIcon}>
                    <Database size={18} />
                  </span>
                  <div>
                    <strong>Quando atuamos como operadores</strong>
                    <p>
                      Dados inseridos pelo Cliente em rotinas de SST, conforme contrato
                      e instruções válidas.
                    </p>
                  </div>
                </div>

                <div className={styles.sideItem}>
                  <span className={styles.sideIcon}>
                    <LockKeyhole size={18} />
                  </span>
                  <div>
                    <strong>Canal oficial / DPO</strong>
                    <p>
                      {privacyHref ? (
                        <a href={privacyHref} className={styles.inlineLink}>
                          {privacyChannel}
                        </a>
                      ) : (
                        privacyChannel
                      )}{' '}
                      · {dpoLabel}
                    </p>
                  </div>
                </div>
              </div>
            </aside>
          </div>
        </section>

        <section className={`${styles.trustStrip} ${styles.privacyTrustStrip}`}>
          <article className={`${styles.trustCard} ${styles.privacyTrustCard}`}>
            <ShieldCheck size={18} />
            <div>
              <strong>Segurança operacional</strong>
              <p>Controles, monitoramento e resposta a incidentes.</p>
            </div>
          </article>
          <article className={`${styles.trustCard} ${styles.privacyTrustCard}`}>
            <Fingerprint size={18} />
            <div>
              <strong>Rastreabilidade</strong>
              <p>Logs, trilhas de auditoria e evidências de tratamento.</p>
            </div>
          </article>
          <article className={`${styles.trustCard} ${styles.privacyTrustCard}`}>
            <Scale size={18} />
            <div>
              <strong>Conformidade</strong>
              <p>LGPD, governança interna e suporte regulatório.</p>
            </div>
          </article>
          <article className={`${styles.trustCard} ${styles.privacyTrustCard}`}>
            <Globe2 size={18} />
            <div>
              <strong>Postura corporativa</strong>
              <p>Estrutura preparada para operações multiempresa e multi-tenant.</p>
            </div>
          </article>
        </section>

        <nav
          className={`${styles.quickNav} ${styles.privacyQuickNav}`}
          aria-label="Navegação da Política de Privacidade"
        >
          <div className={`${styles.quickNavHeader} ${styles.privacyQuickNavHeader}`}>
            <FileCheck2 size={18} />
            Navegação rápida
          </div>
          <div className={`${styles.quickNavList} ${styles.privacyQuickNavList}`}>
            {quickLinks.map((item) => (
              <a
                key={item.id}
                href={`#${item.id}`}
                className={`${styles.quickNavLink} ${styles.privacyQuickNavLink}`}
              >
                {item.label}
              </a>
            ))}
          </div>
        </nav>

        <section className={`${styles.summaryGrid} ${styles.privacySummaryGrid}`}>
          <article className={`${styles.summaryCard} ${styles.privacySummaryCard}`}>
            <p className={styles.summaryLabel}>Responsável pela plataforma</p>
            <h2 className={styles.summaryTitle}>
              {companyName}
              {companyDocument}
            </h2>
            <p className={styles.summaryText}>
              Endereço: {companyAddress}.
            </p>
          </article>

          <article className={`${styles.summaryCard} ${styles.privacySummaryCard}`}>
            <p className={styles.summaryLabel}>Atendimento ao titular</p>
            <h2 className={styles.summaryTitle}>Fluxo orientado por papel regulatório</h2>
            <p className={styles.summaryText}>
              Quando a empresa operadora do SGS atuar como operadora, pedidos do titular devem ser
              direcionados preferencialmente ao controlador (empresa contratante).
            </p>
          </article>

          <article className={`${styles.summaryCard} ${styles.privacySummaryCard}`}>
            <p className={styles.summaryLabel}>Governança corporativa</p>
            <h2 className={styles.summaryTitle}>Segurança, retenção e governança</h2>
            <p className={styles.summaryText}>
              Controles de acesso, segregação multi-tenant por RLS, logs auditáveis
              e procedimentos documentados de continuidade.
            </p>
          </article>
        </section>

        {hasMissingLegalInfo ? (
          <section className={`${styles.warningCard} ${styles.privacyWarningCard}`}>
            <strong>
              <ShieldCheck size={16} />
              Dados institucionais ainda incompletos
            </strong>
            <p>
              A estrutura da política está pronta, mas a publicação definitiva depende
              do preenchimento completo dos campos públicos obrigatórios.
            </p>
          </section>
        ) : null}

        <div className={styles.content}>
          <section className={styles.section} id="escopo">
            <h2>1. Escopo e agentes de tratamento</h2>
            <p>
              O SGS é operado por <strong>{companyName}{companyDocument}</strong>, com
              sede em <strong>{companyAddress}</strong>. A qualificação jurídica como
              controlador ou operador depende da atividade de tratamento concretamente
              desempenhada em cada operação.
            </p>

            <div className={styles.featureGrid}>
              <article className={styles.featureCard}>
                <h3>Controlador</h3>
                <p>
                  Atuamos como controladores quando definimos finalidade, meios e
                  decisões sobre tratamento relacionado à nossa operação institucional:
                  segurança da plataforma, faturamento, marketing B2B, suporte e gestão
                  de contas.
                </p>
              </article>

              <article className={styles.featureCard}>
                <h3>Operador</h3>
                <p>
                  Atuamos como operadores quando tratamos dados inseridos pelo Cliente
                  para gerir SST, treinamentos, evidências, documentos e rotinas
                  ocupacionais — conforme contrato e instruções válidas do Cliente.
                </p>
              </article>
            </div>

            <p className={styles.callout}>
              Para o cenário de operador, a empresa contratante é a controladora.
              Pedidos de titulares relacionados a esses dados devem ser encaminhados
              preferencialmente ao controlador.
            </p>
          </section>

          <section className={styles.section} id="dados">
            <h2>2. Categorias de dados tratados</h2>
            <p>
              Tratamos apenas os dados adequados, pertinentes e necessários para prestar
              o serviço, manter a segurança do ambiente e cumprir obrigações contratuais,
              legais e regulatórias (princípio da necessidade, Art. 6, III, LGPD).
            </p>
            <ul className={styles.bulletList}>
              {dataCategories.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </section>

          <section className={styles.section} id="saude">
            <h2>3. Dados sensíveis de saúde ocupacional (Art. 11, LGPD)</h2>
            <p>
              O SGS pode processar dados de saúde inseridos pelo Cliente, como exames
              médicos periódicos, atestados, CATs (Comunicações de Acidente de Trabalho)
              e laudos ocupacionais. Esses dados são classificados como <strong>dados
                sensíveis</strong> nos termos do art. 5, II e do art. 11 da LGPD.
            </p>
            <ul className={styles.bulletList}>
              <li>
                <strong>Base legal aplicável:</strong> definida pelo controlador conforme
                o caso concreto, normalmente com fundamento no cumprimento de obrigação
                legal ou regulatória (art. 11, II, &ldquo;a&rdquo;) e no exercício regular
                de direitos, inclusive em contrato (art. 11, II, &ldquo;d&rdquo;). A tutela
                da saúde (art. 11, II, &ldquo;f&rdquo;) somente se aplica quando atendidos os
                requisitos legais dessa hipótese.
              </li>
              <li>
                <strong>Acesso restrito:</strong> os dados de saúde são acessíveis
                apenas a usuários autorizados pelo Cliente dentro da mesma organização
                (isolamento multi-tenant por RLS).
              </li>
              <li>
                <strong>Uso em IA:</strong> dados de saúde não devem ser enviados a
                provedores de IA por padrão. Qualquer exceção depende de habilitação
                expressa do Cliente, necessidade demonstrada, base legal adequada,
                minimização e salvaguardas técnicas e contratuais. Pseudonimização não
                equivale, por si só, à anonimização.
              </li>
              <li>
                <strong>Retenção:</strong> conforme legislação trabalhista e de saúde
                ocupacional aplicável, e instrução do controlador (Cliente).
              </li>
            </ul>
          </section>

          <section className={styles.section} id="bases">
            <h2>4. Finalidades e bases legais</h2>
            <p>
              As bases legais variam conforme o contexto de uso e o papel exercido.
            </p>

            <div className={styles.tableWrap}>
              <table className={styles.dataTable}>
                <thead>
                  <tr>
                    <th scope="col">Finalidade</th>
                    <th scope="col">Base legal predominante (LGPD)</th>
                  </tr>
                </thead>
                <tbody>
                  {purposeRows.map(([purpose, basis]) => (
                    <tr key={purpose}>
                      <td>{purpose}</td>
                      <td>{basis}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className={styles.section} id="compartilhamento">
            <h2>5. Suboperadores e cadeia de processamento</h2>
            <p>
              Não comercializamos dados pessoais. Compartilhamos dados apenas com
              suboperadores necessários para a execução do serviço. A contratação,
              região, retenção e salvaguardas de cada provedor devem ser mantidas em
              evidência operacional antes de qualquer declaração de conformidade plena.
            </p>

            <div className={styles.tableWrap}>
              <table className={styles.dataTable}>
                <thead>
                  <tr>
                    <th>Suboperador</th>
                    <th scope="col">Finalidade</th>
                    <th>País</th>
                    <th>Salvaguarda</th>
                  </tr>
                </thead>
                <tbody>
                  {subprocessors.map((sp) => (
                    <tr key={sp.name}>
                      <td><strong>{sp.name}</strong></td>
                      <td>{sp.status}</td>
                      <td>{sp.purpose}</td>
                      <td>{sp.country}</td>
                      <td>{sp.safeguard}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className={styles.callout}>
              Mantemos internamente um inventário de suboperadores, com revisão
              periódica de finalidade, categoria de dados, região, retenção, DPA e
              mecanismo de transferência internacional.
            </p>

            <p className={styles.callout}>
              Também podemos compartilhar dados com autoridades públicas, órgãos
              regulatórios ou terceiros legitimados quando exigido por lei, ordem judicial
              ou investigação formal.
            </p>
          </section>

          <section className={styles.section} id="transferencias">
            <h2>6. Transferências internacionais (Art. 33, LGPD)</h2>
            <p>
              Alguns suboperadores processam dados fora do Brasil. Conforme a tabela
              acima, adotamos as seguintes salvaguardas para cada transferência:
            </p>
            <ul className={styles.bulletList}>
              <li>
                <strong>Mecanismo jurídico válido:</strong> decisão de adequação da ANPD,
                cláusulas-padrão contratuais aprovadas pela ANPD, cláusulas específicas,
                normas corporativas globais ou outra hipótese admitida pelo art. 33 da
                LGPD, conforme o caso.
              </li>
              <li>
                <strong>Governança contratual:</strong> DPA, definição de papéis,
                finalidade, subcontratação, retenção, segurança e apoio ao exercício de
                direitos devem constar do instrumento aplicável.
              </li>
              <li>
                <strong>Minimização técnica:</strong> somente os dados necessários devem
                ser transferidos. Dados sensíveis exigem avaliação reforçada e não devem
                ser enviados quando a finalidade puder ser atendida por dados agregados,
                anonimizados ou pseudonimizados.
              </li>
              <li>
                <strong>Segurança e diligência:</strong> certificações e relatórios de
                auditoria podem apoiar a avaliação do fornecedor, mas não substituem o
                mecanismo jurídico exigido para a transferência.
              </li>
            </ul>
          </section>

          <section className={styles.section} id="retencao">
            <h2>7. Retenção, descarte e exportação</h2>
            <p>
              Os dados são mantidos pelo tempo necessário para cumprir a finalidade,
              respeitar obrigações legais e garantir a continuidade operacional.
            </p>

            <div className={styles.tableWrap}>
              <table className={styles.dataTable}>
                <thead>
                  <tr>
                    <th scope="col">Contexto</th>
                    <th scope="col">Período</th>
                    <th scope="col">Base</th>
                  </tr>
                </thead>
                <tbody>
                  {retentionRows.map((r) => (
                    <tr key={r.context}>
                      <td>{r.context}</td>
                      <td>{r.period}</td>
                      <td>{r.basis}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className={styles.callout}>
              Ao término do contrato, o Cliente tem até 30 dias para exportar seus dados.
              Após esse prazo, os dados são bloqueados, eliminados ou anonimizados
              conforme viabilidade técnica, obrigação legal, backups, storage e retenções
              exigidas por lei.
            </p>

            <p className={styles.callout}>
              A matriz interna de retenção e o checklist de encerramento contratual
              devem permanecer alinhados aos prazos publicados, aos ciclos de backup e
              às obrigações legais de cada categoria documental.
            </p>
          </section>

          <section className={styles.section} id="cookies">
            <h2>8. Cookies e tecnologias semelhantes</h2>
            <p>
              Utilizamos cookies e tecnologias semelhantes necessários à autenticação,
              segurança, continuidade da sessão e registro de preferências funcionais.
              Não utilizamos cookies de publicidade comportamental. Caso ferramentas de
              analytics sejam habilitadas no futuro, esta política e o mecanismo de
              consentimento serão atualizados antes da ativação.
            </p>

            <div className={styles.tableWrap}>
              <table className={styles.dataTable}>
                <thead>
                  <tr>
                    <th scope="col">Cookie</th>
                    <th scope="col">Categoria</th>
                    <th scope="col">Finalidade</th>
                    <th scope="col">Duração</th>
                    <th scope="col">Terceiro</th>
                  </tr>
                </thead>
                <tbody>
                  {cookieRows.map((c) => (
                    <tr key={c.name}>
                      <td><code>{c.name}</code></td>
                      <td>{c.type}</td>
                      <td>{c.purpose}</td>
                      <td>{c.duration}</td>
                      <td>{c.thirdParty}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p>
              Para detalhes completos, acesse nossa{' '}
              <Link href="/cookies" className={styles.inlineLink}>
                Política de Cookies
              </Link>
              .
            </p>
          </section>

          <section className={styles.section} id="direitos">
            <h2>9. Direitos dos titulares (Art. 18, LGPD)</h2>
            <p>
              Os direitos abaixo podem ser exercidos contra o controlador competente.
              Quando a empresa operadora do SGS atuar como operadora, auxiliaremos o Cliente na execução
              desses pedidos dentro dos limites do contrato.
            </p>
            <ul className={styles.bulletList}>
              {rightsList.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <p className={styles.callout}>
              Para dados diretamente controlados por nós, envie sua solicitação para{' '}
              {privacyHref ? (
                <a href={privacyHref} className={styles.inlineLink}>
                  {privacyChannel}
                </a>
              ) : (
                privacyChannel
              )}
              . A confirmação de existência ou o acesso em formato simplificado é atendido
              imediatamente quando possível; a declaração clara e completa é fornecida
              em até 15 dias, contados do requerimento, nos termos do art. 19 da LGPD.
            </p>
          </section>

          <section className={styles.section} id="seguranca">
            <h2>10. Segurança da informação e resposta a incidentes</h2>
            <p>
              Adotamos medidas técnicas e administrativas compatíveis com o risco da
              operação, observando boas práticas de mercado e monitoramento contínuo.
            </p>
            <ul className={styles.bulletList}>
              {securityMeasures.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <p className={styles.callout}>
              Em caso de incidente que possa acarretar risco ou dano relevante, a
              operadora comunicará o controlador sem demora indevida e apoiará a apuração.
              Compete ao controlador comunicar a ANPD e os titulares, quando aplicável,
              em até 3 dias úteis contados do conhecimento de que o incidente afetou dados
              pessoais, ressalvados prazos específicos e as regras aplicáveis a agentes de
              pequeno porte.
            </p>
          </section>

          <section className={styles.section}>
            <h2>11. Atualizações desta política</h2>
            <p>
              Esta política pode ser revisada para refletir mudanças legais,
              operacionais, contratuais ou tecnológicas. Alterações materiais serão
              comunicadas por meio adequado, e a versão vigente permanecerá identificada
              no cabeçalho. Quando a mudança depender de consentimento, a nova manifestação
              será solicitada antes do tratamento correspondente.
            </p>
          </section>

          <section className={styles.section} id="contato">
            <h2>12. Encarregado de Proteção de Dados (DPO) e contato</h2>
            <p>
              Nosso Encarregado de Proteção de Dados ({dpoLabel}) pode ser
              contactado pelos seguintes canais:
            </p>
            <ul className={styles.bulletList}>
              {privacyHref ? (
                <li>
                  <strong>E-mail de privacidade:</strong>{' '}
                  <a href={privacyHref} className={styles.inlineLink}>
                    {privacyChannel}
                  </a>
                </li>
              ) : (
                <li>
                  <strong>Canal de privacidade:</strong> {privacyChannel}
                </li>
              )}
              {dpoEmail && dpoEmail !== legal.privacyEmail ? (
                <li>
                  <strong>E-mail do DPO:</strong>{' '}
                  <a href={`mailto:${dpoEmail}`} className={styles.inlineLink}>
                    {dpoEmail}
                  </a>
                </li>
              ) : null}
              {dpoPhone ? (
                <li>
                  <strong>Telefone do DPO:</strong>{' '}
                  <a href={`tel:${dpoPhone}`} className={styles.inlineLink}>
                    {dpoPhone}
                  </a>
                </li>
              ) : null}
              {showDedicatedSupportChannel ? (
                <li>
                  <strong>Suporte técnico:</strong>{' '}
                  {supportHref ? (
                    <a href={supportHref} className={styles.inlineLink}>
                      {supportChannel}
                    </a>
                  ) : (
                    supportChannel
                  )}
                </li>
              ) : null}
            </ul>

            <p>
              O titular também pode peticionar perante a Autoridade Nacional de Proteção
              de Dados (ANPD) pelos canais oficiais em{' '}
              <a
                href="https://www.gov.br/anpd"
                target="_blank"
                rel="noopener noreferrer"
                className={styles.inlineLink}
              >
                www.gov.br/anpd
              </a>
              .
            </p>
          </section>
        </div>

        <nav className={styles.footerNav} aria-label="Links jurídicos">
          <Link href="/login">Login</Link>
          <Link href="/termos">Termos de Uso</Link>
          <Link href="/cookies">Política de Cookies</Link>
        </nav>

        <p className={styles.footnote}>
          Esta política foi redigida para a operação padrão do SGS (versão {lastUpdated}) e deve ser
          interpretada em conjunto com o contrato comercial, eventuais Acordos de Processamento de
          Dados (DPAs) e instruções formais do Cliente.
        </p>
      </div>
    </div>
  );
}