import { type LucideIcon, AlertTriangle, Archive, ClipboardCheck, FileText, Radio, ShieldCheck, Stethoscope, Users } from 'lucide-react';

import { matchesPathSegment } from './route-config';

export type AiRouteContext = {
  title: string;
  subtitle: string;
  icon: LucideIcon;
  assistantIntro: string;
  promptPrefix: string;
  suggestions: string[];
};

const defaultContext: AiRouteContext = {
  title: 'Chat da SOPHIE',
  subtitle: 'Chat assistente para ideias, documentos, analise de imagem, riscos e orientacao tecnica.',
  icon: ShieldCheck,
  assistantIntro:
    'Sou a SOPHIE da SGS. Posso ajudar com ideias, montar APR, PT, NC e outros documentos, além de analisar imagens e orientar decisões operacionais.',
  promptPrefix:
    'Contexto atual: chat da SOPHIE prestando apoio geral de SST no sistema SGS — Sistema de Gestão de Segurança. Atue como suporte técnico para o TST, com foco em ideias práticas, construção de documentos e decisões operacionais objetivas.',
  suggestions: [
    'Analise os riscos desta foto e diga as acoes imediatas.',
    'Me ajude a montar um documento com base neste contexto.',
    'Me dê ideias objetivas para melhorar esta operação.',
    'Quais bloqueios impedem liberar esta atividade com segurança?',
    'Monte uma orientação rápida de campo para hoje.',
  ],
};

const contexts: Array<{ matcher: (pathname: string) => boolean; context: AiRouteContext }> = [
  {
    matcher: (pathname) => matchesPathSegment(pathname, '/dashboard/tst'),
    context: {
      title: 'Chat da SOPHIE',
      subtitle: 'Suporte ao TST em campo com bloqueios, pendencias do dia, ideias rápidas e analise visual de risco.',
      icon: Radio,
      assistantIntro:
        'Estou no modo TST em campo. Posso priorizar pendências do dia, analisar imagens, validar bloqueios e orientar a liberação operacional.',
      promptPrefix:
        'Contexto atual: tela TST em campo com pendências do dia, consulta por CPF, bloqueios operacionais, fila offline e suporte para análise rápida de risco.',
      suggestions: [
        'Analise esta imagem e aponte risco critico imediato.',
        'Quais prioridades devo atacar primeiro nesta operação?',
        'Como avaliar rapidamente um trabalhador bloqueado por CPF?',
        'Quais ações imediatas tomar em caso de risco crítico em campo?',
      ],
    },
  },
  {
    matcher: (pathname) => matchesPathSegment(pathname, '/dashboard/aprs'),
    context: {
      title: 'Chat da SOPHIE',
      subtitle: 'Risco residual, controles e ajuda para estruturar a APR.',
      icon: FileText,
      assistantIntro:
        'Estou no modo APR. Posso ajudar a revisar perigos, hierarquia de controles e consistência da análise preliminar de risco.',
      promptPrefix:
        'Contexto atual: módulo APR com risco residual, controles e necessidade de evidências operacionais.',
      suggestions: [
        'Revise os principais perigos desta APR.',
        'Quais controles faltam pela hierarquia de proteção?',
        'Como reduzir o risco residual antes da execução?',
      ],
    },
  },
  {
    matcher: (pathname) => matchesPathSegment(pathname, '/dashboard/pts'),
    context: {
      title: 'Chat da SOPHIE',
      subtitle: 'Liberação segura, bloqueios, ideias e evidências antes da aprovação.',
      icon: ClipboardCheck,
      assistantIntro:
        'Estou no modo Permissão de Trabalho. Posso orientar bloqueios, checagens críticas e condições para aprovação segura.',
      promptPrefix:
        'Contexto atual: módulo PT com regras de bloqueio, aprovação e checagens críticas de segurança.',
      suggestions: [
        'Quais requisitos devo validar antes de aprovar a PT?',
        'Liste bloqueios críticos para trabalho em altura.',
        'Como justificar uma reprovação por risco residual crítico?',
      ],
    },
  },
  {
    matcher: (pathname) => matchesPathSegment(pathname, '/dashboard/nonconformities'),
    context: {
      title: 'Chat da SOPHIE',
      subtitle: 'Classificação, criticidade, contenção e plano de ação.',
      icon: AlertTriangle,
      assistantIntro:
        'Estou no modo Não Conformidades. Posso ajudar a classificar criticidade, orientar contenção e estruturar plano de ação.',
      promptPrefix:
        'Contexto atual: módulo de não conformidades com criticidade, CAPA e recorrência operacional.',
      suggestions: [
        'Como classificar esta NC por criticidade?',
        'Quais ações imediatas de contenção devo registrar?',
        'Como estruturar um plano de ação com SLA?',
      ],
    },
  },
  {
    matcher: (pathname) => matchesPathSegment(pathname, '/dashboard/document-registry'),
    context: {
      title: 'Chat da SOPHIE',
      subtitle: 'Pacote semanal, rastreabilidade e apoio documental.',
      icon: Archive,
      assistantIntro:
        'Estou no modo documental. Posso orientar pacotes semanais, rastreabilidade, validação e organização dos documentos.',
      promptPrefix:
        'Contexto atual: registry documental com filtros por empresa, semana, módulo e pacote consolidado.',
      suggestions: [
        'Quais documentos devo incluir no pacote semanal da obra?',
        'Como validar rastreabilidade documental desta semana?',
        'Quais gaps documentais merecem prioridade?',
      ],
    },
  },
  {
    matcher: (pathname) => matchesPathSegment(pathname, '/dashboard/medical-exams'),
    context: {
      title: 'Chat da SOPHIE',
      subtitle: 'Aptidão, vencimentos e bloqueios médicos operacionais.',
      icon: Stethoscope,
      assistantIntro:
        'Estou no modo exames médicos. Posso apoiar vencimentos de ASO, aptidão ocupacional e restrições para operação.',
      promptPrefix:
        'Contexto atual: módulo de exames médicos e aptidão ocupacional com foco em vencimentos e bloqueios.',
      suggestions: [
        'Quais vencimentos precisam de ação nesta semana?',
        'Como tratar operação com ASO vencido?',
        'Quais sinais exigem bloqueio médico imediato?',
      ],
    },
  },
  {
    matcher: (pathname) => matchesPathSegment(pathname, '/dashboard/employees'),
    context: {
      title: 'Chat da SOPHIE',
      subtitle: 'Status operacional do trabalhador e prontidão documental.',
      icon: Users,
      assistantIntro:
        'Estou no modo mobilização. Posso revisar status operacional do trabalhador, documentos pendentes e bloqueios.',
      promptPrefix:
        'Contexto atual: módulo de funcionários e prontidão operacional com foco em mobilização e conformidade.',
      suggestions: [
        'O que preciso validar antes de mobilizar um trabalhador?',
        'Como resumir pendências operacionais por colaborador?',
        'Quais documentos são bloqueantes para entrada em obra?',
      ],
    },
  },
];

export function getAiRouteContext(pathname: string | null | undefined): AiRouteContext {
  if (!pathname) return defaultContext;
  return contexts.find((item) => item.matcher(pathname))?.context ?? defaultContext;
}
