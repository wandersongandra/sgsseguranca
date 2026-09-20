import type { Metadata } from 'next';
import Link from 'next/link';
import { getPublicLegalConfig } from '@/lib/legal';
import styles from './termos.module.css';

export const metadata: Metadata = {
  title: 'Termos de Uso | SGS',
  description:
    'Termos e condições gerais aplicáveis ao acesso e uso profissional do Sistema de Gestão de Segurança (SGS).',
};

const useRestrictions = [
  'Inserir, armazenar ou compartilhar conteúdo ilícito, fraudulento, discriminatório, malicioso ou sem autorização adequada.',
  'Tentar acessar dados de outras organizações, romper o isolamento multiempresa, elevar privilégios ou contornar controles de autorização.',
  'Realizar scraping abusivo, engenharia reversa indevida, varreduras, testes intrusivos, exploração de vulnerabilidades ou simulações de ataque sem autorização prévia e escrita.',
  'Compartilhar credenciais, utilizar contas de terceiros, neutralizar autenticação multifator ou adulterar registros e trilhas de auditoria.',
  'Introduzir malware, código destrutivo, carga excessiva ou qualquer mecanismo capaz de comprometer disponibilidade, integridade ou confidencialidade do serviço.',
  'Utilizar o SGS em desacordo com a legislação, com o contrato, com políticas internas aplicáveis ou para finalidade incompatível com a solução contratada.',
] as const;

const customerDuties = [
  'Designar administradores autorizados e manter atualizados os perfis, permissões, fluxos de aprovação e usuários habilitados.',
  'Garantir que dados, documentos, imagens e instruções inseridos na plataforma sejam lícitos, corretos, pertinentes e tratados com base jurídica adequada.',
  'Observar as Normas Regulamentadoras, regras internas, requisitos profissionais e demais obrigações legais aplicáveis à sua atividade.',
  'Revisar documentos, relatórios, alertas, cálculos e saídas operacionais antes do uso oficial, sobretudo quando exigirem validação técnica ou assinatura de profissional habilitado.',
  'Manter dispositivos, navegadores, redes, integrações e credenciais sob sua administração em condições razoáveis de segurança.',
  'Comunicar prontamente suspeitas de comprometimento, acessos indevidos, falhas relevantes ou uso incompatível com estes Termos.',
] as const;

const accountRules = [
  'Administradores do Cliente respondem pela criação, revisão periódica, suspensão e revogação dos acessos concedidos.',
  'Credenciais são pessoais e intransferíveis; cada usuário deve preservar senha, tokens, segundo fator e mecanismos de recuperação.',
  'O Cliente deverá remover ou bloquear acessos quando houver desligamento, mudança de função ou perda da necessidade de acesso.',
  'A Operadora poderá solicitar medidas adicionais de autenticação ou bloquear preventivamente uma sessão diante de risco razoável de segurança.',
] as const;

const aiRules = [
  'As saídas podem conter erros, omissões, informações incompletas ou resultados inadequados ao contexto específico.',
  'Nenhuma saída deve ser utilizada como laudo, parecer, diagnóstico, decisão ocupacional ou orientação jurídica sem revisão humana qualificada.',
  'O Cliente deve evitar inserir dados pessoais ou sensíveis que não sejam necessários à funcionalidade e observar suas próprias bases legais e políticas internas.',
  'Funcionalidades de IA não devem ser usadas, por si só, para decisões automatizadas com efeitos jurídicos ou impacto relevante sobre pessoas sem governança, transparência e revisão apropriadas.',
  'A disponibilidade, o comportamento e os limites dos modelos podem variar conforme o provedor, a configuração contratada e a evolução tecnológica.',
] as const;

export default function TermosPage() {
  const legal = getPublicLegalConfig();
  const currentVersion = legal.termsVersion ?? '—';
  const companyName =
    legal.companyName ?? 'a operadora identificada no instrumento comercial aplicável';
  const companyDocument = legal.companyDocument
    ? `, inscrita no CPF/CNPJ sob o nº ${legal.companyDocument}`
    : '';
  const companyAddress =
    legal.companyAddress ?? 'endereço indicado no instrumento comercial vigente';
  const supportChannel =
    legal.supportEmail ?? 'canal oficial de suporte informado ao administrador da organização';
  const supportHref = legal.supportEmail ? `mailto:${legal.supportEmail}` : null;
  const forumLabel = legal.forumCityState?.trim() ?? null;
  const hasMissingLegalInfo = legal.missingRequiredFields.length > 0;
  const year = new Date().getFullYear();

  return (
    <div className={styles.page}>
      <div className={styles.wrap}>

        <Link href="/login" className={styles.back}>← Voltar ao login</Link>

        <h1 className={styles.title}>Termos de Uso</h1>

        <table className={styles.metaTable}>
          <tbody>
            <tr>
              <th>Documento</th>
              <td>Termos de Uso — Sistema de Gestão de Segurança (SGS)</td>
            </tr>
            <tr>
              <th>Versão</th>
              <td>{currentVersion}</td>
            </tr>
            <tr>
              <th>Jurisdição</th>
              <td>República Federativa do Brasil</td>
            </tr>
            {forumLabel && (
              <tr>
                <th>Foro</th>
                <td>{forumLabel}</td>
              </tr>
            )}
          </tbody>
        </table>

        {hasMissingLegalInfo && (
          <p className={styles.notice}>
            <strong>Identificação institucional incompleta.</strong> Antes da publicação
            definitiva, preencha os dados públicos da Operadora, a versão dos Termos,
            o canal de suporte e o foro contratual.
          </p>
        )}

        <nav className={styles.toc} aria-label="Índice">
          <p className={styles.tocLabel}>Índice</p>
          <ol>
            <li><a href="#identificacao">1. Identificação, objeto, aceitação e hierarquia contratual</a></li>
            <li><a href="#plataforma">2. Descrição e evolução da plataforma</a></li>
            <li><a href="#contas">3. Elegibilidade, administradores, contas e credenciais</a></li>
            <li><a href="#comercial">4. Condições comerciais, cobrança e tributos</a></li>
            <li><a href="#responsabilidades">5. Responsabilidades do Cliente</a></li>
            <li><a href="#uso">6. Uso permitido e condutas vedadas</a></li>
            <li><a href="#conteudo">7. Conteúdo do Cliente e permissões necessárias</a></li>
            <li><a href="#dados">8. Privacidade, segurança e dados pessoais</a></li>
            <li><a href="#disponibilidade">9. Disponibilidade, manutenção, suporte e continuidade</a></li>
            <li><a href="#ia">10. Funcionalidades de inteligência artificial</a></li>
            <li><a href="#terceiros">11. Integrações, serviços de terceiros e versões experimentais</a></li>
            <li><a href="#propriedade">12. Propriedade intelectual e licença de uso</a></li>
            <li><a href="#confidencialidade">13. Confidencialidade</a></li>
            <li><a href="#suspensao">14. Suspensão, encerramento e exportação de dados</a></li>
            <li><a href="#responsabilidade">15. Garantias, alocação de riscos e limitação de responsabilidade</a></li>
            <li><a href="#alteracoes">16. Alterações dos Termos</a></li>
            <li><a href="#gerais">17. Disposições gerais</a></li>
            <li><a href="#foro">18. Lei aplicável e solução de controvérsias</a></li>
            <li><a href="#contato">19. Contato e suporte</a></li>
          </ol>
        </nav>

        <main>
          <p className={styles.lead}>
            Estes Termos estabelecem as condições gerais de acesso e uso profissional do SGS.
            Eles regulam a relação entre a <strong>Operadora</strong>, o <strong>Cliente</strong>{' '}
            — a organização que contrata a solução — e os usuários autorizados pelo Cliente para
            operar o sistema. Os instrumentos comerciais específicos — proposta, contrato, DPA,
            SLA e demais acordos formalmente celebrados — complementam estes Termos e, nos temas
            que regulamentam especificamente, prevalecem sobre eles.
          </p>
          <p className={styles.lead}>
            Ao acessar ou utilizar o SGS, o Cliente declara ter lido, compreendido e aceito estes
            Termos em nome da organização. A pessoa que realiza o aceite confirma ter poderes para
            vinculá-la ou ter sido devidamente autorizada por seu representante legal.
          </p>

          <section id="identificacao" className={styles.section}>
            <h2>1. Identificação, objeto, aceitação e hierarquia contratual</h2>
            <p>
              O SGS é disponibilizado por{' '}
              <strong>
                {companyName}
                {companyDocument}
              </strong>
              , com endereço em <strong>{companyAddress}</strong>, doravante
              denominada <strong>&quot;Operadora&quot;</strong>.
            </p>
            <p>
              Estes Termos disciplinam o acesso e o uso padrão da plataforma pelo Cliente e
              por seus usuários autorizados. A pessoa que aceita condições em nome do Cliente
              declara possuir poderes para vinculá-lo ou ter sido devidamente autorizada por
              seu representante.
            </p>
            <p>
              Estes Termos devem ser interpretados em conjunto com a proposta, pedido,
              contrato, ordem de serviço, DPA, SLA e demais instrumentos formalmente
              celebrados. Em caso de conflito, prevalece o instrumento específico sobre o tema
              que regulamenta: condições comerciais no pedido ou contrato; proteção de dados
              no DPA; e disponibilidade e suporte no SLA.
            </p>
            <p>
              Alterações materiais destes Termos serão comunicadas por meio adequado. Uma
              atualização pública não altera retroativamente preço, prazo contratado, nível
              de serviço ou outra condição econômica expressamente negociada.
            </p>
          </section>

          <section id="plataforma" className={styles.section}>
            <h2>2. Descrição e evolução da plataforma</h2>
            <p>
              O SGS é uma plataforma SaaS voltada à gestão corporativa de Segurança e Saúde no
              Trabalho, podendo incluir cadastros, documentos, evidências, treinamentos,
              inspeções, alertas, relatórios, auditoria, integrações e recursos opcionais de
              automação e inteligência artificial.
            </p>
            <p>
              Cada Cliente opera dentro de um contexto lógico próprio, com controles de acesso
              e rastreabilidade aplicados conforme a arquitetura e o plano contratados. A
              Operadora poderá aprimorar fluxos, componentes, interfaces e integrações para
              elevar segurança, desempenho e confiabilidade, sem reduzir materialmente
              funcionalidades contratadas sem comunicação ou tratamento contratual adequado.
            </p>
          </section>

          <section id="contas" className={styles.section}>
            <h2>3. Elegibilidade, administradores, contas e credenciais</h2>
            <p>
              O SGS destina-se ao uso profissional por organizações e pessoas autorizadas por
              elas. O acesso depende de convite, cadastro ou habilitação promovida pelo Cliente
              ou pela Operadora conforme o fluxo contratado.
            </p>
            <ul>
              {accountRules.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <p>
              Ações realizadas com credenciais válidas poderão ser atribuídas à conta
              correspondente, sem prejuízo da apuração de comprometimento, fraude ou falha
              técnica devidamente demonstrada.
            </p>
          </section>

          <section id="comercial" className={styles.section}>
            <h2>4. Condições comerciais, cobrança e tributos</h2>
            <p>
              Preços, franquias, quantidade de usuários, módulos, vigência, reajustes, forma
              de pagamento, tributos, renovação e condições de cancelamento são os previstos
              no instrumento comercial aplicável.
            </p>
            <p>
              O atraso de pagamento poderá resultar em cobrança, restrição ou suspensão do
              serviço nos termos do contrato, preferencialmente após comunicação e oportunidade
              razoável de regularização, salvo risco, fraude ou obrigação legal que exija
              medida imediata.
            </p>
          </section>

          <section id="responsabilidades" className={styles.section}>
            <h2>5. Responsabilidades do Cliente</h2>
            <p>
              O Cliente define a finalidade operacional de uso e responde pelo conteúdo, pelos
              usuários, pelas instruções e pelas decisões tomadas com apoio da plataforma.
            </p>
            <ul>
              {customerDuties.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <p>
              O SGS é uma ferramenta de apoio à gestão. A validação técnica, jurídica, médica,
              trabalhista e ocupacional dos atos praticados permanece sob responsabilidade do
              Cliente e dos profissionais legalmente habilitados.
            </p>
          </section>

          <section id="uso" className={styles.section}>
            <h2>6. Uso permitido e condutas vedadas</h2>
            <p>
              A plataforma deve ser utilizada somente para finalidades legítimas, compatíveis
              com a contratação e com a legislação aplicável. São vedadas, entre outras, as
              seguintes condutas:
            </p>
            <ul>
              {useRestrictions.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <p>
              Pesquisas de segurança, testes de carga, pentests ou avaliações intrusivas
              dependem de autorização prévia e escrita, escopo definido, janela aprovada e
              regras de engajamento que protejam os demais Clientes e a continuidade do serviço.
            </p>
          </section>

          <section id="conteudo" className={styles.section}>
            <h2>7. Conteúdo do Cliente e permissões necessárias</h2>
            <p>
              Dados, arquivos, documentos, imagens, registros e demais materiais inseridos pelo
              Cliente permanecem sob sua titularidade ou sob a titularidade de quem legitimamente
              detenha os respectivos direitos.
            </p>
            <p>
              O Cliente concede à Operadora, durante a vigência e pelo período necessário ao
              encerramento técnico, autorização limitada para hospedar, copiar, transmitir,
              organizar, processar, gerar backups e exibir esse conteúdo exclusivamente para
              prestar, proteger, suportar e aprimorar o serviço nos limites do contrato e da
              legislação.
            </p>
            <p>
              O Cliente declara possuir os direitos, autorizações e bases jurídicas necessários
              para inserir e instruir o tratamento do conteúdo, inclusive quando envolver dados
              pessoais, dados sensíveis, imagem, voz, documentos de terceiros ou propriedade
              intelectual alheia.
            </p>
          </section>

          <section id="dados" className={styles.section}>
            <h2>8. Privacidade, segurança e dados pessoais</h2>
            <p>
              O tratamento de dados pessoais observa a Política de Privacidade, o contrato e,
              quando aplicável, o DPA. A qualificação da Operadora como controladora ou operadora
              depende da atividade de tratamento concretamente realizada.
            </p>
            <p>
              Quando o Cliente atuar como controlador, deverá definir bases legais, finalidades,
              permissões, retenção, atendimento aos titulares e instruções documentadas. A
              Operadora tratará os dados conforme tais instruções, salvo obrigação legal em
              sentido diverso.
            </p>
            <p>
              Em incidente relacionado a dados tratados em nome do Cliente, a Operadora
              comunicará o contato designado sem atraso injustificado, observando o DPA ou o
              prazo contratual aplicável, e fornecerá informações razoavelmente disponíveis
              para apoiar a avaliação e as comunicações exigidas. Quando atuar como
              controladora, a Operadora cumprirá diretamente as obrigações legais e
              regulatórias que lhe forem aplicáveis.
            </p>
            <p>
              Para detalhes sobre categorias de dados, retenção, suboperadores, transferências
              e direitos dos titulares, consulte a{' '}
              <Link href="/privacidade">Política de Privacidade</Link>.
            </p>
          </section>

          <section id="disponibilidade" className={styles.section}>
            <h2>9. Disponibilidade, manutenção, suporte e continuidade</h2>
            <p>
              A Operadora emprega esforços comercialmente razoáveis para manter o serviço
              disponível, seguro e funcional. Compromissos mensuráveis de disponibilidade,
              tempos de resposta, recuperação e créditos de serviço somente se aplicam quando
              previstos em SLA ou instrumento equivalente.
            </p>
            <p>
              Manutenções programadas, correções emergenciais e atualizações de segurança
              poderão afetar temporariamente o acesso. Sempre que razoavelmente possível,
              intervenções planejadas com impacto relevante serão comunicadas pelos canais
              operacionais disponíveis.
            </p>
            <p>
              Eventos fora do controle razoável das partes, incluindo falhas amplas de
              telecomunicações, energia, serviços públicos, atos de autoridade, desastres e
              ataques generalizados, serão tratados conforme o contrato e a legislação, sem
              afastar os deveres de mitigação e continuidade razoavelmente aplicáveis.
            </p>
          </section>

          <section id="ia" className={styles.section}>
            <h2>10. Funcionalidades de inteligência artificial</h2>
            <p>
              Recursos de IA, quando contratados e habilitados por administrador autorizado,
              possuem caráter auxiliar. Eles podem apoiar pesquisa, resumo, classificação,
              análise visual, elaboração de rascunhos e outras tarefas, mas não substituem
              análise humana, responsabilidade profissional ou cumprimento regulatório.
            </p>
            <ul>
              {aiRules.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <p>
              A ativação administrativa de uma funcionalidade não substitui a definição da
              base legal cabível para cada tratamento. Quando houver envio de conteúdo a
              provedores externos de IA, os fornecedores e as salvaguardas aplicáveis deverão
              constar da Política de Privacidade ou do instrumento contratual.
            </p>
          </section>

          <section id="terceiros" className={styles.section}>
            <h2>11. Integrações, serviços de terceiros e versões experimentais</h2>
            <p>
              Algumas funcionalidades podem depender de infraestrutura, APIs, provedores de
              identidade, e-mail, armazenamento, observabilidade ou inteligência artificial de
              terceiros. A disponibilidade desses recursos poderá variar em razão de mudanças
              técnicas, comerciais ou regulatórias externas.
            </p>
            <p>
              Integrações habilitadas pelo Cliente podem estar sujeitas a termos próprios do
              terceiro. O Cliente responde pela legitimidade das credenciais e pelos dados que
              decidir encaminhar por essas integrações.
            </p>
            <p>
              Funcionalidades identificadas como beta, piloto, prévia ou experimental poderão
              sofrer alterações, possuir limitações e ser descontinuadas. Elas não integrarão
              compromissos críticos de produção salvo previsão expressa no contrato.
            </p>
          </section>

          <section id="propriedade" className={styles.section}>
            <h2>12. Propriedade intelectual e licença de uso</h2>
            <p>
              A plataforma, marca, arquitetura, código, documentação, interfaces, modelos,
              fluxos e materiais próprios são de titularidade da Operadora ou de seus
              licenciantes, sem transferência de propriedade ao Cliente.
            </p>
            <p>
              Durante a vigência e enquanto adimplente, o Cliente recebe licença limitada,
              não exclusiva, intransferível e não sublicenciável para utilizar o SGS em suas
              operações internas, conforme o plano, a documentação e os instrumentos
              contratados.
            </p>
            <p>
              Componentes de terceiros e software de código aberto permanecem sujeitos às
              respectivas licenças. Sugestões e feedbacks voluntários poderão ser usados pela
              Operadora para aprimorar o produto, sem acesso ou divulgação indevida de
              informações confidenciais do Cliente.
            </p>
          </section>

          <section id="confidencialidade" className={styles.section}>
            <h2>13. Confidencialidade</h2>
            <p>
              Cada parte deverá proteger informações técnicas, comerciais, estratégicas e
              operacionais recebidas da outra parte e identificadas como confidenciais ou que,
              por sua natureza, devam razoavelmente ser tratadas como tal.
            </p>
            <p>
              A obrigação não se aplica a informações comprovadamente públicas sem violação,
              já conhecidas legitimamente, desenvolvidas de forma independente ou recebidas
              licitamente de terceiro. Divulgação por obrigação legal deverá, quando
              permitido, ser precedida de comunicação à parte afetada.
            </p>
            <p>
              Prazos, medidas adicionais e penalidades de confidencialidade serão aqueles
              previstos no contrato, DPA ou acordo específico aplicável.
            </p>
          </section>

          <section id="suspensao" className={styles.section}>
            <h2>14. Suspensão, encerramento e exportação de dados</h2>
            <p>
              A Operadora poderá restringir ou suspender acesso em caso de risco relevante de
              segurança, uso abusivo, fraude, determinação legal, inadimplemento ou
              descumprimento material. Quando a urgência não justificar ação imediata, será
              buscada comunicação prévia e oportunidade razoável de correção.
            </p>
            <p>
              Após o término contratual, o Cliente terá a janela de exportação estabelecida no
              contrato. Na ausência de prazo específico, será adotado o período padrão de{' '}
              <strong>30 (trinta) dias corridos</strong>, sujeito à identidade e autorização
              do solicitante, às ferramentas disponíveis e ao formato tecnicamente suportado.
            </p>
            <p>
              Encerrada a janela aplicável, dados serão eliminados, anonimizados ou bloqueados
              conforme a Política de Privacidade e as obrigações legais. Cópias residuais
              poderão permanecer temporariamente em backups protegidos até o encerramento do
              ciclo técnico de retenção, sem retorno ao uso operacional.
            </p>
          </section>

          <section id="responsabilidade" className={styles.section}>
            <h2>15. Garantias, alocação de riscos e limitação de responsabilidade</h2>
            <p>
              O SGS será prestado de acordo com o contrato e com padrões razoáveis de
              diligência técnica. A Operadora não garante que o serviço será totalmente livre
              de interrupções, que todos os resultados atenderão a finalidades não contratadas
              ou que dados incorretos inseridos pelo Cliente produzirão saídas corretas.
            </p>
            <p>
              Na extensão permitida pela legislação, nenhuma parte responderá por danos
              indiretos, especiais, punitivos ou consequenciais, nem por lucros cessantes ou
              perda de oportunidade que não sejam consequência direta e comprovada do
              inadimplemento.
            </p>
            <p>
              Salvo limite diferente em contrato, a responsabilidade total e cumulativa da
              Operadora por danos diretos comprovados relacionados ao serviço ficará limitada
              ao montante efetivamente pago pelo Cliente pelo SGS nos 12 (doze) meses
              anteriores ao fato gerador.
            </p>
            <p>
              As exclusões e o limite acima não se aplicam quando vedados por lei, nem a
              obrigações de pagamento do Cliente, dolo, fraude, culpa grave, violação de
              propriedade intelectual de terceiros, quebra de confidencialidade ou
              descumprimento de obrigações de proteção de dados e segurança imputável à parte
              responsável.
            </p>
            <p>
              O Cliente responderá por reclamações de terceiros decorrentes de conteúdo,
              instruções ou uso ilícito sob sua responsabilidade, desde que a Operadora o
              comunique e permita participação razoável na defesa. Essa obrigação não se
              aplica na medida em que o dano tenha sido causado pela própria Operadora.
            </p>
          </section>

          <section id="alteracoes" className={styles.section}>
            <h2>16. Alterações dos Termos</h2>
            <p>
              A Operadora poderá atualizar estes Termos para refletir mudanças legais,
              regulatórias, técnicas ou operacionais. Alterações relevantes serão comunicadas
              com antecedência razoável, salvo necessidade urgente de segurança, prevenção de
              fraude ou cumprimento legal.
            </p>
            <p>
              Mudanças que dependam de novo aceite, renovação ou aditivo produzirão efeitos
              conforme o mecanismo contratual aplicável. A versão vigente permanecerá
              identificada no cabeçalho desta página.
            </p>
          </section>

          <section id="gerais" className={styles.section}>
            <h2>17. Disposições gerais</h2>
            <p>
              A tolerância de uma parte não representa renúncia a direito. A invalidade de
              uma disposição não prejudicará as demais, devendo a cláusula afetada ser
              interpretada ou substituída de modo compatível com sua finalidade legítima.
            </p>
            <p>
              O Cliente não poderá ceder o contrato ou o acesso ao SGS sem autorização, salvo
              reorganização societária permitida pelo instrumento comercial. A Operadora
              poderá realizar reorganizações ou cessões relacionadas ao negócio, preservando
              as obrigações assumidas e comunicando quando contratualmente exigido.
            </p>
            <p>
              Comunicações operacionais e contratuais poderão ocorrer por e-mail, avisos
              dentro da plataforma ou outros canais cadastrados pelo Cliente. O Cliente é
              responsável por manter seus contatos atualizados.
            </p>
          </section>

          <section id="foro" className={styles.section}>
            <h2>18. Lei aplicável e solução de controvérsias</h2>
            <p>
              Estes Termos são regidos pelas leis da República Federativa do Brasil. As partes
              buscarão inicialmente solução de boa-fé pelos canais contratuais.
            </p>
            <p>
              Para controvérsias não solucionadas, será competente{' '}
              {forumLabel ? (
                <>o foro da comarca de <strong>{forumLabel}</strong></>
              ) : (
                <>o foro definido no contrato comercial ou, na falta dele, o foro legalmente competente</>
              )}
              , ressalvadas competências obrigatórias e direitos que não possam ser afastados
              por convenção.
            </p>
          </section>

          <section id="contato" className={styles.section}>
            <h2>19. Contato e suporte</h2>
            <p>
              Dúvidas contratuais, operacionais ou solicitações de suporte podem ser
              encaminhadas para{' '}
              {supportHref ? (
                <a href={supportHref}>{supportChannel}</a>
              ) : (
                supportChannel
              )}
              .
            </p>
          </section>
        </main>

        <footer className={styles.footer}>
          <nav className={styles.footerLinks} aria-label="Links jurídicos">
            <Link href="/login">Login</Link>
            <Link href="/privacidade">Política de Privacidade</Link>
            <Link href="/cookies">Política de Cookies</Link>
          </nav>
          <p>
            Versão {currentVersion} · Regido pelas leis da República Federativa do Brasil
            {forumLabel ? ` · Foro: ${forumLabel}` : ''}
          </p>
          <p>© {year} {legal.companyName ?? 'SGS'}. Todos os direitos reservados.</p>
        </footer>

      </div>
    </div>
  );
}
