import type { Metadata } from 'next';
import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import {
  ArrowLeft,
  BadgeCheck,
  BriefcaseBusiness,
  Building2,
  FileLock2,
  Handshake,
  LockKeyhole,
  Shield,
  ShieldCheck,
  Sparkles,
  UsersRound,
} from 'lucide-react';
import { getPublicLegalConfig } from '@/lib/legal';
import styles from '../legal-pages.module.css';

export const metadata: Metadata = {
  title: 'Termos de Uso | SGS',
  description:
    'Termos e condições para acesso e uso corporativo do SGS - Sistema de Gestão de Segurança.',
};

type TextItem = string;

type ExecutivePoint = {
  icon: LucideIcon;
  label: string;
  title: string;
  text: string;
};

type PlatformPillar = {
  title: string;
  text: string;
};

type ClauseHighlight = {
  id: string;
  label: string;
};

const useRestrictions = [
  'Inserir, armazenar ou compartilhar conteúdo ilícito, fraudulento, discriminatório, malicioso ou sem autorização adequada.',
  'Tentar acessar dados de outras organizações, romper o isolamento multiempresa, elevar privilégios ou contornar controles de autorização.',
  'Realizar scraping abusivo, engenharia reversa indevida, varreduras, testes intrusivos, exploração de vulnerabilidades ou simulações de ataque sem autorização prévia e escrita.',
  'Compartilhar credenciais, utilizar contas de terceiros, neutralizar autenticação multifator ou adulterar registros e trilhas de auditoria.',
  'Introduzir malware, código destrutivo, carga excessiva ou qualquer mecanismo capaz de comprometer disponibilidade, integridade ou confidencialidade do serviço.',
  'Utilizar o SGS em desacordo com a legislação, com o contrato, com políticas internas aplicáveis ou para finalidade incompatível com a solução contratada.',
] as const satisfies readonly TextItem[];

const customerDuties = [
  'Designar administradores autorizados e manter atualizados os perfis, permissões, fluxos de aprovação e usuários habilitados.',
  'Garantir que dados, documentos, imagens e instruções inseridos na plataforma sejam lícitos, corretos, pertinentes e tratados com base jurídica adequada.',
  'Observar as Normas Regulamentadoras, regras internas, requisitos profissionais e demais obrigações legais aplicáveis à sua atividade.',
  'Revisar documentos, relatórios, alertas, cálculos e saídas operacionais antes do uso oficial, sobretudo quando exigirem validação técnica ou assinatura de profissional habilitado.',
  'Manter dispositivos, navegadores, redes, integrações e credenciais sob sua administração em condições razoáveis de segurança.',
  'Comunicar prontamente suspeitas de comprometimento, acessos indevidos, falhas relevantes ou uso incompatível com estes Termos.',
] as const satisfies readonly TextItem[];

const accountRules = [
  'Administradores do Cliente respondem pela criação, revisão periódica, suspensão e revogação dos acessos concedidos.',
  'Credenciais são pessoais e intransferíveis; cada usuário deve preservar senha, tokens, segundo fator e mecanismos de recuperação.',
  'O Cliente deverá remover ou bloquear acessos quando houver desligamento, mudança de função ou perda da necessidade de acesso.',
  'A Operadora poderá solicitar medidas adicionais de autenticação ou bloquear preventivamente uma sessão diante de risco razoável de segurança.',
] as const satisfies readonly TextItem[];

const aiRules = [
  'As saídas podem conter erros, omissões, informações incompletas ou resultados inadequados ao contexto específico.',
  'Nenhuma saída deve ser utilizada como laudo, parecer, diagnóstico, decisão ocupacional ou orientação jurídica sem revisão humana qualificada.',
  'O Cliente deve evitar inserir dados pessoais ou sensíveis que não sejam necessários à funcionalidade e observar suas próprias bases legais e políticas internas.',
  'Funcionalidades de IA não devem ser usadas, por si só, para decisões automatizadas com efeitos jurídicos ou impacto relevante sobre pessoas sem governança, transparência e revisão apropriadas.',
  'A disponibilidade, o comportamento e os limites dos modelos podem variar conforme o provedor, a configuração contratada e a evolução tecnológica.',
] as const satisfies readonly TextItem[];

const executivePoints = [
  {
    icon: Building2,
    label: 'Operação corporativa',
    title: 'Estrutura B2B com governança clara',
    text: 'Papéis, acessos, limites e responsabilidades definidos para uso empresarial.',
  },
  {
    icon: ShieldCheck,
    label: 'Segurança e rastreabilidade',
    title: 'Credenciais individuais e trilha de auditoria',
    text: 'Ações relevantes podem ser associadas ao usuário, à organização e ao contexto operacional.',
  },
  {
    icon: FileLock2,
    label: 'Base documental',
    title: 'Instrumentos específicos prevalecem',
    text: 'Proposta, contrato, DPA e SLA complementam estes Termos em seus respectivos temas.',
  },
] as const satisfies readonly ExecutivePoint[];

const platformPillars = [
  {
    title: 'Ambiente multiempresa',
    text: 'Segregação lógica, políticas de acesso e estrutura voltada à operação de múltiplas organizações.',
  },
  {
    title: 'Uso orientado por governança',
    text: 'O SGS apoia processos, mas não substitui validação técnica, decisão jurídica ou responsabilidade ocupacional.',
  },
  {
    title: 'Serviço evolutivo',
    text: 'A plataforma pode receber melhorias técnicas, visuais e operacionais preservando direitos contratados e segurança.',
  },
] as const satisfies readonly PlatformPillar[];

const clauseHighlights = [
  { id: 'objeto', label: 'Objeto, identificação e hierarquia contratual' },
  { id: 'contas', label: 'Contas, credenciais e administradores' },
  { id: 'responsabilidades', label: 'Responsabilidades do Cliente' },
  { id: 'uso', label: 'Uso permitido e condutas vedadas' },
  { id: 'dados', label: 'Conteúdo, privacidade e dados pessoais' },
  { id: 'disponibilidade', label: 'Disponibilidade, suporte e incidentes' },
  { id: 'ia', label: 'IA como apoio e revisão humana' },
  { id: 'responsabilidade', label: 'Responsabilidade, suspensão e encerramento' },
] as const satisfies readonly ClauseHighlight[];

export default function TermosPage() {
  const legal = getPublicLegalConfig();
  const currentVersion = legal.termsVersion || '—';

  const companyName =
    legal.companyName || 'a operadora identificada no instrumento comercial aplicável';
  const companyDocument = legal.companyDocument
    ? `, inscrita no CPF/CNPJ sob o nº ${legal.companyDocument}`
    : '';
  const companyAddress =
    legal.companyAddress || 'endereço indicado no instrumento comercial vigente';

  const supportChannel =
    legal.supportEmail ||
    'canal oficial de suporte informado ao administrador da organização';
  const supportHref = legal.supportEmail ? `mailto:${legal.supportEmail}` : null;
  const forumLabel = legal.forumCityState?.trim() || null;
  const hasMissingLegalInfo = legal.missingRequiredFields.length > 0;

  return (
    <div className={styles.page}>
      <div className={styles.shell}>
        <Link href="/login" className={styles.backLink}>
          <ArrowLeft size={16} aria-hidden="true" />
          Voltar ao login
        </Link>

        <section className={styles.termsHero} aria-labelledby="terms-title">
          <div className={styles.termsHeroGlow} aria-hidden="true" />
          <div className={styles.termsHeroGlowSecondary} aria-hidden="true" />

          <div className={styles.termsHeroGrid}>
            <div className={styles.termsHeroMain}>
              <span className={styles.termsHeroEyebrow}>
                <Handshake size={14} aria-hidden="true" />
                Regras de uso, governança e responsabilidade operacional
              </span>

              <h1 id="terms-title" className={styles.termsHeroTitle}>
                Termos de Uso para uma
                <span className={styles.termsHeroAccent}>
                  {' '}operação segura e governada
                </span>
              </h1>

              <p className={styles.termsHeroDescription}>
                Estes Termos estabelecem as condições gerais de acesso e uso profissional
                do SGS. O objetivo é oferecer uma base clara para a relação entre a
                Operadora, o Cliente e seus usuários autorizados, sem substituir os
                instrumentos comerciais específicos firmados entre as partes.
              </p>

              <div className={styles.termsHeroMeta}>
                <span className={`${styles.metaPill} ${styles.termsMetaPill}`}>
                  <BadgeCheck size={14} aria-hidden="true" />
                  Versão vigente: {currentVersion}
                </span>
                <span className={`${styles.metaPill} ${styles.termsMetaPill}`}>
                  <BriefcaseBusiness size={14} aria-hidden="true" />
                  SaaS corporativo para SST
                </span>
                <span className={`${styles.metaPill} ${styles.termsMetaPill}`}>
                  <LockKeyhole size={14} aria-hidden="true" />
                  Regras, limites e proteção do ambiente
                </span>
              </div>

              <div className={styles.termsTrustStrip}>
                <div className={styles.termsTrustItem}>
                  <strong>Uso B2B</strong>
                  <span>Foco em operação empresarial</span>
                </div>
                <div className={styles.termsTrustItem}>
                  <strong>Auditoria</strong>
                  <span>Rastreabilidade por usuário</span>
                </div>
                <div className={styles.termsTrustItem}>
                  <strong>Contrato</strong>
                  <span>Instrumentos específicos prevalecem</span>
                </div>
                <div className={styles.termsTrustItem}>
                  <strong>Suporte</strong>
                  <span>Canal oficial centralizado</span>
                </div>
              </div>
            </div>

            <aside className={styles.termsHeroPanel} aria-label="Visão executiva dos Termos">
              <div className={styles.termsPanelTop}>
                <span className={styles.termsPanelBadge}>
                  <Sparkles size={14} aria-hidden="true" />
                  Visão executiva
                </span>
                <h2 className={styles.termsPanelTitle}>
                  Base jurídica para uso profissional do SGS
                </h2>
                <p className={styles.termsPanelText}>
                  Estes Termos formam a camada geral de governança do produto. Condições
                  econômicas, níveis de serviço, proteção de dados e escopos específicos
                  permanecem disciplinados pelos instrumentos próprios.
                </p>
              </div>

              <div className={styles.termsMiniList}>
                <div className={styles.sideItem}>
                  <span className={styles.sideIcon} aria-hidden="true">
                    <UsersRound size={18} />
                  </span>
                  <div>
                    <strong>Cliente</strong>
                    <p>
                      Pessoa jurídica ou organização que contrata a solução, administra
                      acessos e define a finalidade operacional de uso.
                    </p>
                  </div>
                </div>

                <div className={styles.sideItem}>
                  <span className={styles.sideIcon} aria-hidden="true">
                    <Shield size={18} />
                  </span>
                  <div>
                    <strong>Usuário autorizado</strong>
                    <p>
                      Pessoa habilitada pelo Cliente para acessar o SGS com credenciais
                      individuais e atuação rastreável.
                    </p>
                  </div>
                </div>

                <div className={styles.sideItem}>
                  <span className={styles.sideIcon} aria-hidden="true">
                    <Handshake size={18} />
                  </span>
                  <div>
                    <strong>Canal oficial</strong>
                    <p>
                      {supportHref ? (
                        <a href={supportHref} className={styles.inlineLink}>
                          {supportChannel}
                        </a>
                      ) : (
                        supportChannel
                      )}
                    </p>
                  </div>
                </div>
              </div>
            </aside>
          </div>
        </section>

        <section className={styles.executiveGrid} aria-label="Resumo executivo">
          {executivePoints.map(({ icon: Icon, label, title, text }) => (
            <article key={title} className={styles.executiveCard}>
              <span className={styles.executiveIcon} aria-hidden="true">
                <Icon size={18} />
              </span>
              <p className={styles.executiveLabel}>{label}</p>
              <h2 className={styles.executiveTitle}>{title}</h2>
              <p className={styles.executiveText}>{text}</p>
            </article>
          ))}
        </section>

        <section className={styles.impactBand} aria-labelledby="quick-summary-title">
          <div className={styles.impactBandMain}>
            <p className={styles.summaryLabel}>Leitura rápida</p>
            <h2 id="quick-summary-title" className={styles.impactBandTitle}>
              Os Termos em menos de 30 segundos
            </h2>
            <p className={styles.summaryText}>
              A Operadora mantém a infraestrutura e a evolução técnica do SGS conforme o
              contrato. O Cliente administra usuários, responde pelo conteúdo inserido e
              valida tecnicamente o uso dos resultados. Nenhuma funcionalidade substitui
              obrigações legais ou a atuação de profissionais habilitados.
            </p>
          </div>

          <div className={styles.glanceGrid}>
            {platformPillars.map((item) => (
              <article key={item.title} className={styles.glanceCard}>
                <h3>{item.title}</h3>
                <p>{item.text}</p>
              </article>
            ))}
          </div>
        </section>

        {hasMissingLegalInfo ? (
          <section className={styles.warningCard} role="status">
            <strong>
              <Shield size={16} aria-hidden="true" />
              Identificação institucional incompleta
            </strong>
            <p>
              Antes da publicação definitiva, preencha e valide os dados públicos da
              Operadora, a versão dos Termos, o canal de suporte e o foro contratual.
            </p>
          </section>
        ) : null}

        <nav className={styles.clauseOverview} aria-label="Mapa dos Termos de Uso">
          <div className={styles.clauseOverviewHeader}>
            <p className={styles.summaryLabel}>Mapa do documento</p>
            <h2 className={styles.summaryTitle}>
              Principais frentes cobertas nestes Termos
            </h2>
          </div>

          <div className={styles.clauseGrid}>
            {clauseHighlights.map((item, index) => (
              <a key={item.id} href={`#${item.id}`} className={styles.clauseCard}>
                <span className={styles.clauseNumber} aria-hidden="true">
                  {(index + 1).toString().padStart(2, '0')}
                </span>
                <p>{item.label}</p>
              </a>
            ))}
          </div>
        </nav>

        <main className={styles.content}>
          <section className={styles.section} id="objeto">
            <h2>1. Identificação, objeto, aceitação e hierarquia contratual</h2>
            <p>
              O SGS é disponibilizado por <strong>{companyName}{companyDocument}</strong>,
              com endereço em <strong>{companyAddress}</strong>, doravante denominada
              &quot;Operadora&quot;.
            </p>
            <p>
              Estes Termos disciplinam o acesso e o uso padrão da plataforma pelo Cliente
              e por seus usuários autorizados. A pessoa que aceita condições em nome do
              Cliente declara possuir poderes para vinculá-lo ou ter sido devidamente
              autorizada por seu representante.
            </p>
            <p>
              Estes Termos devem ser interpretados em conjunto com a proposta, pedido,
              contrato, ordem de serviço, DPA, SLA e demais instrumentos formalmente
              celebrados. Em caso de conflito, prevalece o instrumento específico sobre o
              tema que regulamenta: condições comerciais no pedido ou contrato; proteção
              de dados no DPA; e disponibilidade e suporte no SLA.
            </p>
            <p className={styles.callout}>
              Alterações materiais destes Termos serão comunicadas por meio adequado. Uma
              atualização pública não altera retroativamente preço, prazo contratado,
              nível de serviço ou outra condição econômica expressamente negociada.
            </p>
          </section>

          <section className={styles.section} id="plataforma">
            <h2>2. Descrição e evolução da plataforma</h2>
            <p>
              O SGS é uma plataforma SaaS voltada à gestão corporativa de Segurança e
              Saúde no Trabalho, podendo incluir cadastros, documentos, evidências,
              treinamentos, inspeções, alertas, relatórios, auditoria, integrações e
              recursos opcionais de automação e inteligência artificial.
            </p>

            <div className={styles.featureGrid}>
              <article className={styles.featureCard}>
                <h3>Ambiente multiempresa</h3>
                <p>
                  Cada Cliente opera dentro de um contexto lógico próprio, com controles
                  de acesso e rastreabilidade aplicados conforme a arquitetura e o plano
                  contratados.
                </p>
              </article>

              <article className={styles.featureCard}>
                <h3>Serviço evolutivo</h3>
                <p>
                  A Operadora poderá aprimorar fluxos, componentes, interfaces e
                  integrações para elevar segurança, desempenho e confiabilidade, sem
                  reduzir materialmente funcionalidades contratadas sem comunicação ou
                  tratamento contratual adequado.
                </p>
              </article>
            </div>
          </section>

          <section className={styles.section} id="contas">
            <h2>3. Elegibilidade, administradores, contas e credenciais</h2>
            <p>
              O SGS destina-se ao uso profissional por organizações e pessoas autorizadas
              por elas. O acesso depende de convite, cadastro ou habilitação promovida pelo
              Cliente ou pela Operadora conforme o fluxo contratado.
            </p>
            <ul className={styles.bulletList}>
              {accountRules.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <p className={styles.callout}>
              Ações realizadas com credenciais válidas poderão ser atribuídas à conta
              correspondente, sem prejuízo da apuração de comprometimento, fraude ou falha
              técnica devidamente demonstrada.
            </p>
          </section>

          <section className={styles.section} id="comercial">
            <h2>4. Condições comerciais, cobrança e tributos</h2>
            <p>
              Preços, franquias, quantidade de usuários, módulos, vigência, reajustes,
              forma de pagamento, tributos, renovação e condições de cancelamento são os
              previstos no instrumento comercial aplicável.
            </p>
            <p>
              O atraso de pagamento poderá resultar em cobrança, restrição ou suspensão
              do serviço nos termos do contrato, preferencialmente após comunicação e
              oportunidade razoável de regularização, salvo risco, fraude ou obrigação
              legal que exija medida imediata.
            </p>
          </section>

          <section className={styles.section} id="responsabilidades">
            <h2>5. Responsabilidades do Cliente</h2>
            <p>
              O Cliente define a finalidade operacional de uso e responde pelo conteúdo,
              pelos usuários, pelas instruções e pelas decisões tomadas com apoio da
              plataforma.
            </p>
            <ul className={styles.bulletList}>
              {customerDuties.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <p className={styles.callout}>
              O SGS é uma ferramenta de apoio à gestão. A validação técnica, jurídica,
              médica, trabalhista e ocupacional dos atos praticados permanece sob
              responsabilidade do Cliente e dos profissionais legalmente habilitados.
            </p>
          </section>

          <section className={styles.section} id="uso">
            <h2>6. Uso permitido e condutas vedadas</h2>
            <p>
              A plataforma deve ser utilizada somente para finalidades legítimas,
              compatíveis com a contratação e com a legislação aplicável.
            </p>
            <ul className={styles.bulletList}>
              {useRestrictions.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <p>
              Pesquisas de segurança, testes de carga, pentests ou avaliações intrusivas
              dependem de autorização prévia e escrita, escopo definido, janela aprovada
              e regras de engajamento que protejam os demais Clientes e a continuidade do
              serviço.
            </p>
          </section>

          <section className={styles.section} id="conteudo">
            <h2>7. Conteúdo do Cliente e permissões necessárias</h2>
            <p>
              Dados, arquivos, documentos, imagens, registros e demais materiais inseridos
              pelo Cliente permanecem sob sua titularidade ou sob a titularidade de quem
              legitimamente detenha os respectivos direitos.
            </p>
            <p>
              O Cliente concede à Operadora, durante a vigência e pelo período necessário
              ao encerramento técnico, autorização limitada para hospedar, copiar,
              transmitir, organizar, processar, gerar backups e exibir esse conteúdo
              exclusivamente para prestar, proteger, suportar e aprimorar o serviço nos
              limites do contrato e da legislação.
            </p>
            <p>
              O Cliente declara possuir os direitos, autorizações e bases jurídicas
              necessários para inserir e instruir o tratamento do conteúdo, inclusive
              quando envolver dados pessoais, dados sensíveis, imagem, voz, documentos de
              terceiros ou propriedade intelectual alheia.
            </p>
          </section>

          <section className={styles.section} id="dados">
            <h2>8. Privacidade, segurança e dados pessoais</h2>
            <p>
              O tratamento de dados pessoais observa a Política de Privacidade, o contrato
              e, quando aplicável, o DPA. A qualificação da Operadora como controladora ou
              operadora depende da atividade de tratamento concretamente realizada.
            </p>
            <p>
              Quando o Cliente atuar como controlador, deverá definir bases legais,
              finalidades, permissões, retenção, atendimento aos titulares e instruções
              documentadas. A Operadora tratará os dados conforme tais instruções, salvo
              obrigação legal em sentido diverso.
            </p>
            <p>
              Em incidente relacionado a dados tratados em nome do Cliente, a Operadora
              comunicará o contato designado sem atraso injustificado, observando o DPA ou
              o prazo contratual aplicável, e fornecerá informações razoavelmente
              disponíveis para apoiar a avaliação e as comunicações exigidas. Quando atuar
              como controladora, a Operadora cumprirá diretamente as obrigações legais e
              regulatórias que lhe forem aplicáveis.
            </p>
            <p className={styles.callout}>
              Para detalhes sobre categorias de dados, retenção, suboperadores,
              transferências e direitos dos titulares, consulte a{' '}
              <Link href="/privacidade" className={styles.inlineLink}>
                Política de Privacidade
              </Link>
              .
            </p>
          </section>

          <section className={styles.section} id="disponibilidade">
            <h2>9. Disponibilidade, manutenção, suporte e continuidade</h2>
            <p>
              A Operadora emprega esforços comercialmente razoáveis para manter o serviço
              disponível, seguro e funcional. Compromissos mensuráveis de disponibilidade,
              tempos de resposta, recuperação e créditos de serviço somente se aplicam
              quando previstos em SLA ou instrumento equivalente.
            </p>
            <p>
              Manutenções programadas, correções emergenciais e atualizações de segurança
              poderão afetar temporariamente o acesso. Sempre que razoavelmente possível,
              intervenções planejadas com impacto relevante serão comunicadas pelos canais
              operacionais disponíveis.
            </p>
            <p>
              Eventos fora do controle razoável das partes, incluindo falhas amplas de
              telecomunicações, energia, serviços públicos, atos de autoridade, desastres
              e ataques generalizados, serão tratados conforme o contrato e a legislação,
              sem afastar os deveres de mitigação e continuidade razoavelmente aplicáveis.
            </p>
          </section>

          <section className={styles.section} id="ia">
            <h2>10. Funcionalidades de inteligência artificial</h2>
            <p>
              Recursos de IA, quando contratados e habilitados por administrador
              autorizado, possuem caráter auxiliar. Eles podem apoiar pesquisa, resumo,
              classificação, análise visual, elaboração de rascunhos e outras tarefas,
              mas não substituem análise humana, responsabilidade profissional ou
              cumprimento regulatório.
            </p>
            <ul className={styles.bulletList}>
              {aiRules.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <p>
              A ativação administrativa de uma funcionalidade não substitui a definição
              da base legal cabível para cada tratamento. Quando houver envio de conteúdo
              a provedores externos de IA, os fornecedores e as salvaguardas aplicáveis
              deverão constar da Política de Privacidade ou do instrumento contratual.
            </p>
          </section>

          <section className={styles.section} id="terceiros">
            <h2>11. Integrações, serviços de terceiros e versões experimentais</h2>
            <p>
              Algumas funcionalidades podem depender de infraestrutura, APIs, provedores
              de identidade, e-mail, armazenamento, observabilidade ou inteligência
              artificial de terceiros. A disponibilidade desses recursos poderá variar em
              razão de mudanças técnicas, comerciais ou regulatórias externas.
            </p>
            <p>
              Integrações habilitadas pelo Cliente podem estar sujeitas a termos próprios
              do terceiro. O Cliente responde pela legitimidade das credenciais e pelos
              dados que decidir encaminhar por essas integrações.
            </p>
            <p>
              Funcionalidades identificadas como beta, piloto, prévia ou experimental
              poderão sofrer alterações, possuir limitações e ser descontinuadas. Elas não
              integrarão compromissos críticos de produção salvo previsão expressa no
              contrato.
            </p>
          </section>

          <section className={styles.section} id="propriedade">
            <h2>12. Propriedade intelectual e licença de uso</h2>
            <p>
              A plataforma, marca, arquitetura, código, documentação, interfaces, modelos,
              fluxos e materiais próprios são de titularidade da Operadora ou de seus
              licenciantes, sem transferência de propriedade ao Cliente.
            </p>
            <p>
              Durante a vigência e enquanto adimplente, o Cliente recebe licença limitada,
              não exclusiva, intransferível e não sublicenciável para utilizar o SGS em
              suas operações internas, conforme o plano, a documentação e os instrumentos
              contratados.
            </p>
            <p>
              Componentes de terceiros e software de código aberto permanecem sujeitos às
              respectivas licenças. Sugestões e feedbacks voluntários poderão ser usados
              pela Operadora para aprimorar o produto, sem acesso ou divulgação indevida
              de informações confidenciais do Cliente.
            </p>
          </section>

          <section className={styles.section} id="confidencialidade">
            <h2>13. Confidencialidade</h2>
            <p>
              Cada parte deverá proteger informações técnicas, comerciais, estratégicas e
              operacionais recebidas da outra parte e identificadas como confidenciais ou
              que, por sua natureza, devam razoavelmente ser tratadas como tal.
            </p>
            <p>
              A obrigação não se aplica a informações comprovadamente públicas sem
              violação, já conhecidas legitimamente, desenvolvidas de forma independente
              ou recebidas licitamente de terceiro. Divulgação por obrigação legal deverá,
              quando permitido, ser precedida de comunicação à parte afetada.
            </p>
            <p>
              Prazos, medidas adicionais e penalidades de confidencialidade serão aqueles
              previstos no contrato, DPA ou acordo específico aplicável.
            </p>
          </section>

          <section className={styles.section} id="suspensao">
            <h2>14. Suspensão, encerramento e exportação de dados</h2>
            <p>
              A Operadora poderá restringir ou suspender acesso em caso de risco relevante
              de segurança, uso abusivo, fraude, determinação legal, inadimplemento ou
              descumprimento material. Quando a urgência não justificar ação imediata,
              será buscada comunicação prévia e oportunidade razoável de correção.
            </p>
            <p>
              Após o término contratual, o Cliente terá a janela de exportação estabelecida
              no contrato. Na ausência de prazo específico, será adotado o período padrão
              de <strong>30 (trinta) dias corridos</strong>, sujeito à identidade e
              autorização do solicitante, às ferramentas disponíveis e ao formato
              tecnicamente suportado.
            </p>
            <p>
              Encerrada a janela aplicável, dados serão eliminados, anonimizados ou
              bloqueados conforme a Política de Privacidade e as obrigações legais. Cópias
              residuais poderão permanecer temporariamente em backups protegidos até o
              encerramento do ciclo técnico de retenção, sem retorno ao uso operacional.
            </p>
          </section>

          <section className={styles.section} id="responsabilidade">
            <h2>15. Garantias, alocação de riscos e limitação de responsabilidade</h2>
            <p>
              O SGS será prestado de acordo com o contrato e com padrões razoáveis de
              diligência técnica. A Operadora não garante que o serviço será totalmente
              livre de interrupções, que todos os resultados atenderão a finalidades não
              contratadas ou que dados incorretos inseridos pelo Cliente produzirão saídas
              corretas.
            </p>
            <p>
              Na extensão permitida pela legislação, nenhuma parte responderá por danos
              indiretos, especiais, punitivos ou consequenciais, nem por lucros cessantes
              ou perda de oportunidade que não sejam consequência direta e comprovada do
              inadimplemento.
            </p>
            <p>
              Salvo limite diferente em contrato, a responsabilidade total e cumulativa
              da Operadora por danos diretos comprovados relacionados ao serviço ficará
              limitada ao montante efetivamente pago pelo Cliente pelo SGS nos 12 (doze)
              meses anteriores ao fato gerador.
            </p>
            <p className={styles.callout}>
              As exclusões e o limite acima não se aplicam quando vedados por lei, nem a
              obrigações de pagamento do Cliente, dolo, fraude, culpa grave, violação de
              propriedade intelectual de terceiros, quebra de confidencialidade ou
              descumprimento de obrigações de proteção de dados e segurança imputável à
              parte responsável.
            </p>
            <p>
              O Cliente responderá por reclamações de terceiros decorrentes de conteúdo,
              instruções ou uso ilícito sob sua responsabilidade, desde que a Operadora o
              comunique e permita participação razoável na defesa. Essa obrigação não se
              aplica na medida em que o dano tenha sido causado pela própria Operadora.
            </p>
          </section>

          <section className={styles.section} id="alteracoes">
            <h2>16. Alterações dos Termos</h2>
            <p>
              A Operadora poderá atualizar estes Termos para refletir mudanças legais,
              regulatórias, técnicas ou operacionais. Alterações relevantes serão
              comunicadas com antecedência razoável, salvo necessidade urgente de
              segurança, prevenção de fraude ou cumprimento legal.
            </p>
            <p>
              Mudanças que dependam de novo aceite, renovação ou aditivo produzirão efeitos
              conforme o mecanismo contratual aplicável. A versão vigente permanecerá
              identificada no cabeçalho desta página.
            </p>
          </section>

          <section className={styles.section} id="gerais">
            <h2>17. Disposições gerais</h2>
            <p>
              A tolerância de uma parte não representa renúncia a direito. A invalidade de
              uma disposição não prejudicará as demais, devendo a cláusula afetada ser
              interpretada ou substituída de modo compatível com sua finalidade legítima.
            </p>
            <p>
              O Cliente não poderá ceder o contrato ou o acesso ao SGS sem autorização,
              salvo reorganização societária permitida pelo instrumento comercial. A
              Operadora poderá realizar reorganizações ou cessões relacionadas ao negócio,
              preservando as obrigações assumidas e comunicando quando contratualmente
              exigido.
            </p>
            <p>
              Comunicações operacionais e contratuais poderão ocorrer por e-mail, avisos
              dentro da plataforma ou outros canais cadastrados pelo Cliente. O Cliente é
              responsável por manter seus contatos atualizados.
            </p>
          </section>

          <section className={styles.section} id="foro">
            <h2>18. Lei aplicável e solução de controvérsias</h2>
            <p>
              Estes Termos são regidos pelas leis da República Federativa do Brasil. As
              partes buscarão inicialmente solução de boa-fé pelos canais contratuais.
            </p>
            <p>
              Para controvérsias não solucionadas, será competente{' '}
              {forumLabel ? (
                <>
                  o foro da comarca de <strong>{forumLabel}</strong>
                </>
              ) : (
                <>o foro definido no contrato comercial ou, na falta dele, o foro legalmente competente</>
              )}
              , ressalvadas competências obrigatórias e direitos que não possam ser
              afastados por convenção.
            </p>
          </section>

          <section className={styles.section} id="contato">
            <h2>19. Contato e suporte</h2>
            <p>
              Dúvidas contratuais, operacionais ou solicitações de suporte podem ser
              encaminhadas para{' '}
              {supportHref ? (
                <a href={supportHref} className={styles.inlineLink}>
                  {supportChannel}
                </a>
              ) : (
                supportChannel
              )}
              .
            </p>
          </section>
        </main>

        <section className={styles.ctaBand} aria-labelledby="terms-cta-title">
          <div>
            <p className={styles.summaryLabel}>Base jurídica do produto</p>
            <h2 id="terms-cta-title" className={styles.ctaTitle}>
              Regras claras reduzem risco operacional e atrito comercial
            </h2>
            <p className={styles.ctaText}>
              Termos consistentes reforçam segurança jurídica, reduzem ambiguidades e
              elevam a confiança de clientes corporativos, auditorias e áreas de
              compliance.
            </p>
          </div>

          <div className={styles.ctaActions}>
            <Link href="/privacidade" className={styles.ctaPrimary}>
              Ver Política de Privacidade
            </Link>
            <Link href="/login" className={styles.ctaSecondary}>
              Ir para o login
            </Link>
          </div>
        </section>

        <nav className={styles.footerNav} aria-label="Links jurídicos">
          <Link href="/login">Login</Link>
          <Link href="/privacidade">Política de Privacidade</Link>
          <Link href="/cookies">Política de Cookies</Link>
        </nav>

        <p className={styles.footnote}>
          Estes Termos estabelecem condições gerais de uso do SGS. Propostas, contratos,
          ordens de serviço, DPAs e SLAs formalmente celebrados permanecem aplicáveis e
          prevalecem nos temas que regulamentam especificamente.
        </p>
      </div>
    </div>
  );
}