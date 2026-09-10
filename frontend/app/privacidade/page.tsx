import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { getPublicLegalConfig } from '@/lib/legal';
import { PrivacyToc } from './PrivacyToc';
import styles from './privacidade.module.css';

export const metadata: Metadata = {
  title: 'Política de Privacidade | SGS',
  description:
    'Política de privacidade e tratamento de dados pessoais do SGS em conformidade com a Lei Geral de Proteção de Dados (LGPD).',
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
    'Execução do contrato (art. 7º, V), legítimo interesse (art. 7º, IX) e, quando houver dado sensível de autenticação, prevenção à fraude e segurança do titular (art. 11, II, "g")',
  ],
  [
    'Gestão de documentos, treinamentos, evidências e rotinas de SST',
    'Execução do contrato (art. 7º, V) e cumprimento de obrigação legal ou regulatória pelo controlador (art. 7º, II)',
  ],
  [
    'Exames, laudos, atestados e demais dados de saúde ocupacional',
    'Cumprimento de obrigação legal ou regulatória pelo controlador (art. 11, II, "a") e exercício regular de direitos, inclusive em contrato (art. 11, II, "d"); tutela da saúde (art. 11, II, "f") somente quando aplicável ao agente e ao contexto do tratamento',
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
    safeguard: 'Criptografia em trânsito e em repouso. DPA, região, backups e retenção devem corresponder ao contrato e à configuração de produção.',
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
    purpose: 'Processamento de linguagem e análise de imagens em funcionalidades de IA da Sophie, quando habilitadas.',
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
    purpose: 'Permite renovar a sessão sem nova autenticação. HttpOnly, Secure, SameSite=Strict.',
    duration: 'Até 30 dias',
    thirdParty: 'Não',
  },
  {
    name: 'refresh_csrf',
    type: 'Estritamente necessário',
    purpose: 'Proteção CSRF no fluxo de renovação de sessão.',
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
    type: 'Estritamente necessário (quando ativo)',
    purpose: 'Mitigação de bots e proteção de borda da Cloudflare.',
    duration: 'Conforme Cloudflare',
    thirdParty: 'Cloudflare',
  },
  {
    name: 'sgs_company_id',
    type: 'Estritamente necessário',
    purpose: 'Contexto da organização selecionada. Autorização e isolamento sempre validados no servidor.',
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
] as const;

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

function statusClass(status: SubprocessorRow['status'], s: typeof styles) {
  if (status === 'Ativo') return s.statusActive;
  if (status === 'Condicional') return s.statusCond;
  if (status === 'Opcional') return s.statusOptional;
  return s.statusPending;
}

export default function PrivacidadePage() {
  const legal = getPublicLegalConfig();
  const policyVersion = legal.policyVersion || '—';
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
  const year = new Date().getFullYear();

  return (
    <div className={styles.page}>
      <div className={styles.shell}>

        <Link href="/login" className={styles.backLink}>
          <ArrowLeft size={14} aria-hidden="true" />
          Voltar ao login
        </Link>

        <header className={styles.docHeader} aria-labelledby="privacy-title">
          <p className={styles.docEyebrow} aria-hidden="true">Documento jurídico</p>

          <h1 id="privacy-title" className={styles.docTitle}>
            Política de Privacidade
          </h1>

          <p className={styles.docSubtitle}>
            Descreve como o SGS trata dados pessoais, as bases legais aplicáveis,
            os papéis dos agentes de tratamento e os direitos dos titulares,
            em conformidade com a Lei Geral de Proteção de Dados.
          </p>

          <div className={styles.docMetaRow} aria-label="Informações do documento">
            <span className={styles.docMetaItem}>Versão {policyVersion}</span>
            <span className={styles.docMetaSep} aria-hidden="true">|</span>
            <span className={styles.docMetaItem}>LGPD · Lei 13.709/2018</span>
            <span className={styles.docMetaSep} aria-hidden="true">|</span>
            <span className={styles.docMetaItem}>Regido pela legislação brasileira</span>
          </div>

          <nav className={styles.docPolicyLinks} aria-label="Documentos relacionados">
            <span className={styles.docPolicyLabel}>Ver também:</span>
            <Link href="/termos" className={styles.docPolicyLink}>
              Termos de Uso
            </Link>
            <Link href="/cookies" className={styles.docPolicyLink}>
              Política de Cookies
            </Link>
          </nav>
        </header>

        {hasMissingLegalInfo ? (
          <div className={styles.incompleteNotice} role="status">
            <strong>Dados institucionais incompletos</strong>
            <p>
              A estrutura da política está pronta, mas a publicação definitiva depende
              do preenchimento completo dos campos públicos obrigatórios.
            </p>
          </div>
        ) : null}

        <div className={styles.layout}>
          <PrivacyToc />

          <main className={styles.content}>
            <div className={styles.intro}>
              <p className={styles.introText}>
                Esta política descreve como a{' '}
                <strong className={styles.term}>Operadora</strong> — empresa responsável
                pelo SGS — trata dados pessoais no âmbito da plataforma. A qualificação
                como controladora ou operadora depende da atividade de tratamento
                concretamente realizada em cada operação.
              </p>
              <p className={styles.introText}>
                Quando o <strong className={styles.term}>Cliente</strong> insere dados
                de trabalhadores em rotinas de SST, a Operadora atua como operadora e o
                Cliente é o controlador. Pedidos de titulares relacionados a esses dados
                devem ser direcionados preferencialmente ao controlador.
              </p>
              <div className={styles.callout}>
                Esta política deve ser lida em conjunto com o contrato comercial, eventuais
                Acordos de Processamento de Dados (DPAs) e as instruções formais do
                Cliente no exercício de seu papel de controlador.
              </div>
            </div>

            {/* ── 01 ─────────────────────────────────────────────────── */}
            <section id="escopo" className={styles.section}>
              <p className={styles.sectionNum} aria-hidden="true">01</p>
              <h2 className={styles.sectionHeading}>Escopo e agentes de tratamento</h2>
              <p>
                O SGS é operado por{' '}
                <strong>{companyName}{companyDocument}</strong>, com
                sede em <strong>{companyAddress}</strong>.
              </p>

              <div className={styles.roleBlock}>
                <div className={styles.roleItem}>
                  <strong>Quando atuamos como controladores</strong>
                  <p>
                    Definimos finalidade, meios e decisões sobre tratamento relacionado à
                    nossa operação institucional: segurança da plataforma, faturamento,
                    marketing B2B, suporte e gestão de contas.
                  </p>
                </div>
                <div className={styles.roleItem}>
                  <strong>Quando atuamos como operadores</strong>
                  <p>
                    Tratamos dados inseridos pelo Cliente para gerir SST, treinamentos,
                    evidências, documentos e rotinas ocupacionais — conforme contrato e
                    instruções válidas do Cliente.
                  </p>
                </div>
              </div>

              <div className={styles.callout}>
                Para o cenário de operador, a empresa contratante é a controladora.
                Pedidos de titulares relacionados a esses dados devem ser encaminhados
                preferencialmente ao controlador.
              </div>
            </section>

            {/* ── 02 ─────────────────────────────────────────────────── */}
            <section id="dados" className={styles.section}>
              <p className={styles.sectionNum} aria-hidden="true">02</p>
              <h2 className={styles.sectionHeading}>Categorias de dados tratados</h2>
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

            {/* ── 03 ─────────────────────────────────────────────────── */}
            <section id="saude" className={styles.section}>
              <p className={styles.sectionNum} aria-hidden="true">03</p>
              <h2 className={styles.sectionHeading}>
                Dados de saúde ocupacional (Art. 11, LGPD)
              </h2>
              <p>
                O SGS pode processar dados de saúde inseridos pelo Cliente, como exames
                médicos periódicos, atestados, CATs e laudos ocupacionais. Esses dados são
                classificados como <strong>dados sensíveis</strong> nos termos do art. 5,
                II e do art. 11 da LGPD.
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
                  minimização e salvaguardas técnicas e contratuais.
                </li>
                <li>
                  <strong>Retenção:</strong> conforme legislação trabalhista e de saúde
                  ocupacional aplicável, e instrução do controlador (Cliente).
                </li>
              </ul>
            </section>

            {/* ── 04 ─────────────────────────────────────────────────── */}
            <section id="bases" className={`${styles.section} ${styles.wide}`}>
              <p className={styles.sectionNum} aria-hidden="true">04</p>
              <h2 className={styles.sectionHeading}>Finalidades e bases legais</h2>
              <p>As bases legais variam conforme o contexto de uso e o papel exercido.</p>

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

            {/* ── 05 ─────────────────────────────────────────────────── */}
            <section id="compartilhamento" className={`${styles.section} ${styles.wide}`}>
              <p className={styles.sectionNum} aria-hidden="true">05</p>
              <h2 className={styles.sectionHeading}>
                Suboperadores e cadeia de processamento
              </h2>
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
                      <th scope="col">Suboperador</th>
                      <th scope="col">Status</th>
                      <th scope="col">Finalidade</th>
                      <th scope="col">País</th>
                      <th scope="col">Salvaguarda</th>
                    </tr>
                  </thead>
                  <tbody>
                    {subprocessors.map((sp) => (
                      <tr key={sp.name}>
                        <td><strong>{sp.name}</strong></td>
                        <td className={statusClass(sp.status, styles)}>{sp.status}</td>
                        <td>{sp.purpose}</td>
                        <td>{sp.country}</td>
                        <td>{sp.safeguard}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className={styles.callout}>
                Mantemos internamente um inventário de suboperadores, com revisão
                periódica de finalidade, categoria de dados, região, retenção, DPA e
                mecanismo de transferência internacional.
              </div>
              <div className={styles.callout}>
                Também podemos compartilhar dados com autoridades públicas, órgãos
                regulatórios ou terceiros legitimados quando exigido por lei, ordem
                judicial ou investigação formal.
              </div>
            </section>

            {/* ── 06 ─────────────────────────────────────────────────── */}
            <section id="transferencias" className={styles.section}>
              <p className={styles.sectionNum} aria-hidden="true">06</p>
              <h2 className={styles.sectionHeading}>
                Transferências internacionais (Art. 33, LGPD)
              </h2>
              <p>
                Alguns suboperadores processam dados fora do Brasil. Adotamos as
                seguintes salvaguardas para cada transferência:
              </p>
              <ul className={styles.bulletList}>
                <li>
                  <strong>Mecanismo jurídico válido:</strong> decisão de adequação da
                  ANPD, cláusulas-padrão contratuais aprovadas pela ANPD, cláusulas
                  específicas, normas corporativas globais ou outra hipótese admitida
                  pelo art. 33 da LGPD, conforme o caso.
                </li>
                <li>
                  <strong>Governança contratual:</strong> DPA, definição de papéis,
                  finalidade, subcontratação, retenção, segurança e apoio ao exercício
                  de direitos devem constar do instrumento aplicável.
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

            {/* ── 07 ─────────────────────────────────────────────────── */}
            <section id="retencao" className={`${styles.section} ${styles.wide}`}>
              <p className={styles.sectionNum} aria-hidden="true">07</p>
              <h2 className={styles.sectionHeading}>Retenção, descarte e exportação</h2>
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

              <div className={styles.callout}>
                Ao término do contrato, o Cliente tem até 30 dias para exportar seus dados.
                Após esse prazo, os dados são bloqueados, eliminados ou anonimizados
                conforme viabilidade técnica, obrigação legal, backups e retenções
                exigidas por lei.
              </div>
            </section>

            {/* ── 08 ─────────────────────────────────────────────────── */}
            <section id="cookies" className={`${styles.section} ${styles.wide}`}>
              <p className={styles.sectionNum} aria-hidden="true">08</p>
              <h2 className={styles.sectionHeading}>
                Cookies e tecnologias semelhantes
              </h2>
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
                Para detalhes completos, acesse a{' '}
                <Link href="/cookies" className={styles.inlineLink}>
                  Política de Cookies
                </Link>
                .
              </p>
            </section>

            {/* ── 09 ─────────────────────────────────────────────────── */}
            <section id="direitos" className={styles.section}>
              <p className={styles.sectionNum} aria-hidden="true">09</p>
              <h2 className={styles.sectionHeading}>
                Direitos dos titulares (Art. 18, LGPD)
              </h2>
              <p>
                Os direitos abaixo podem ser exercidos contra o controlador competente.
                Quando a Operadora atuar como operadora, auxiliará o Cliente na execução
                desses pedidos dentro dos limites do contrato.
              </p>
              <ul className={styles.bulletList}>
                {rightsList.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
              <div className={styles.callout}>
                Para dados diretamente controlados pela Operadora, envie sua solicitação
                para{' '}
                {privacyHref ? (
                  <a href={privacyHref} className={styles.inlineLink}>
                    {privacyChannel}
                  </a>
                ) : (
                  privacyChannel
                )}
                . A confirmação de existência ou o acesso em formato simplificado é
                atendido imediatamente quando possível; a declaração clara e completa é
                fornecida em até 15 dias, contados do requerimento, nos termos do art.
                19 da LGPD.
              </div>
            </section>

            {/* ── 10 ─────────────────────────────────────────────────── */}
            <section id="seguranca" className={styles.section}>
              <p className={styles.sectionNum} aria-hidden="true">10</p>
              <h2 className={styles.sectionHeading}>
                Segurança da informação e resposta a incidentes
              </h2>
              <p>
                Adotamos medidas técnicas e administrativas compatíveis com o risco da
                operação, observando boas práticas de mercado e monitoramento contínuo.
              </p>
              <ul className={styles.bulletList}>
                {securityMeasures.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
              <div className={styles.callout}>
                Em caso de incidente que possa acarretar risco ou dano relevante, a
                Operadora comunicará o controlador sem demora indevida e apoiará a
                apuração. Compete ao controlador comunicar a ANPD e os titulares, quando
                aplicável, em até 3 dias úteis contados do conhecimento de que o
                incidente afetou dados pessoais, ressalvados prazos específicos.
              </div>
            </section>

            {/* ── 11 ─────────────────────────────────────────────────── */}
            <section id="atualizacoes" className={styles.section}>
              <p className={styles.sectionNum} aria-hidden="true">11</p>
              <h2 className={styles.sectionHeading}>Atualizações desta política</h2>
              <p>
                Esta política pode ser revisada para refletir mudanças legais,
                operacionais, contratuais ou tecnológicas. Alterações materiais serão
                comunicadas por meio adequado, e a versão vigente permanecerá
                identificada no cabeçalho. Quando a mudança depender de consentimento,
                a nova manifestação será solicitada antes do tratamento correspondente.
              </p>
            </section>

            {/* ── 12 ─────────────────────────────────────────────────── */}
            <section id="contato" className={styles.section}>
              <p className={styles.sectionNum} aria-hidden="true">12</p>
              <h2 className={styles.sectionHeading}>
                Encarregado de Proteção de Dados (DPO) e contato
              </h2>
              <p>
                O Encarregado de Proteção de Dados — <strong>{dpoLabel}</strong> —
                pode ser contactado pelos seguintes canais:
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
                O titular também pode peticionar perante a Autoridade Nacional de
                Proteção de Dados (ANPD) pelos canais oficiais em{' '}
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
          </main>
        </div>

        <footer className={styles.footer}>
          <nav className={styles.footerNav} aria-label="Links jurídicos e navegação">
            <Link href="/login">Login</Link>
            <Link href="/termos">Termos de Uso</Link>
            <Link href="/cookies">Política de Cookies</Link>
          </nav>
          <p className={styles.footerMeta}>
            Versão {policyVersion} · LGPD Lei 13.709/2018 · Regido pela legislação brasileira
          </p>
          <p className={styles.footerCopy}>
            © {year} {legal.companyName ?? 'SGS'}. Todos os direitos reservados.
          </p>
        </footer>

      </div>
    </div>
  );
}
