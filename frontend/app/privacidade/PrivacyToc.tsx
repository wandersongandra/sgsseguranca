'use client';

import { useEffect, useState } from 'react';
import styles from './privacidade.module.css';

const sections = [
  { id: 'escopo',           num: '01', label: 'Escopo e agentes de tratamento' },
  { id: 'dados',            num: '02', label: 'Categorias de dados tratados' },
  { id: 'saude',            num: '03', label: 'Dados de saúde ocupacional' },
  { id: 'bases',            num: '04', label: 'Finalidades e bases legais' },
  { id: 'compartilhamento', num: '05', label: 'Suboperadores' },
  { id: 'transferencias',   num: '06', label: 'Transferências internacionais' },
  { id: 'retencao',         num: '07', label: 'Retenção e descarte' },
  { id: 'cookies',          num: '08', label: 'Cookies' },
  { id: 'direitos',         num: '09', label: 'Direitos dos titulares' },
  { id: 'seguranca',        num: '10', label: 'Segurança e incidentes' },
  { id: 'atualizacoes',     num: '11', label: 'Atualizações da política' },
  { id: 'contato',          num: '12', label: 'DPO e contato' },
] as const;

export function PrivacyToc() {
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
      <aside className={styles.toc} aria-label="Sumário da política">
        <p className={styles.tocTitle} aria-hidden="true">Sumário</p>
        <nav aria-label="Seções da Política de Privacidade">{navContent}</nav>
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
        <nav className={styles.mobileTocNav} aria-label="Seções da Política de Privacidade">
          {navContent}
        </nav>
      </details>
    </>
  );
}
