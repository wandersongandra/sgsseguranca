'use client';

import { useEffect, useState } from 'react';
import styles from './termos.module.css';

const sections = [
  { id: 'identificacao',      num: '01', label: 'Identificação e objeto' },
  { id: 'plataforma',         num: '02', label: 'Descrição da plataforma' },
  { id: 'contas',             num: '03', label: 'Contas e credenciais' },
  { id: 'comercial',          num: '04', label: 'Condições comerciais' },
  { id: 'responsabilidades',  num: '05', label: 'Responsabilidades do Cliente' },
  { id: 'uso',                num: '06', label: 'Uso permitido' },
  { id: 'conteudo',           num: '07', label: 'Conteúdo do Cliente' },
  { id: 'dados',              num: '08', label: 'Privacidade e segurança' },
  { id: 'disponibilidade',    num: '09', label: 'Disponibilidade e suporte' },
  { id: 'ia',                 num: '10', label: 'Inteligência artificial' },
  { id: 'terceiros',          num: '11', label: 'Integrações' },
  { id: 'propriedade',        num: '12', label: 'Propriedade intelectual' },
  { id: 'confidencialidade',  num: '13', label: 'Confidencialidade' },
  { id: 'suspensao',          num: '14', label: 'Suspensão e encerramento' },
  { id: 'responsabilidade',   num: '15', label: 'Garantias e responsabilidade' },
  { id: 'alteracoes',         num: '16', label: 'Alterações dos Termos' },
  { id: 'gerais',             num: '17', label: 'Disposições gerais' },
  { id: 'foro',               num: '18', label: 'Lei aplicável' },
  { id: 'contato',            num: '19', label: 'Contato' },
] as const;

export function TermsToc() {
  const [activeId, setActiveId] = useState('');

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        const first = visible[0];
        if (first) {
          setActiveId(first.target.id);
        }
      },
      { rootMargin: '-88px 0px -50% 0px', threshold: 0 },
    );

    sections.forEach(({ id }) => {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    });

    return () => observer.disconnect();
  }, []);

  const scrollTo =
    (id: string) => (e: React.MouseEvent<HTMLAnchorElement>) => {
      e.preventDefault();
      const el = document.getElementById(id);
      if (!el) return;
      const top = el.getBoundingClientRect().top + window.scrollY - 96;
      window.scrollTo({ top, behavior: 'smooth' });
      window.history.pushState(null, '', `#${id}`);
      setActiveId(id);
    };

  const navContent = (
    <ol className={styles.tocList}>
      {sections.map(({ id, num, label }) => (
        <li key={id}>
          <a
            href={`#${id}`}
            onClick={scrollTo(id)}
            className={`${styles.tocLink} ${activeId === id ? styles.tocLinkActive : ''}`}
            aria-current={activeId === id ? 'location' : undefined}
          >
            <span className={styles.tocNum} aria-hidden="true">{num}</span>
            <span>{label}</span>
          </a>
        </li>
      ))}
    </ol>
  );

  return (
    <>
      {/* Desktop: sticky sidebar */}
      <aside className={styles.toc} aria-label="Sumário do documento">
        <p className={styles.tocTitle} aria-hidden="true">Sumário</p>
        <nav aria-label="Cláusulas dos Termos de Uso">{navContent}</nav>
      </aside>

      {/* Mobile: disclosure */}
      <details className={styles.mobileToc}>
        <summary className={styles.mobileTocSummary}>
          <span>Sumário</span>
          <svg
            className={styles.mobileTocChevron}
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M4 6l4 4 4-4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </summary>
        <nav className={styles.mobileTocNav} aria-label="Cláusulas dos Termos de Uso">{navContent}</nav>
      </details>
    </>
  );
}
