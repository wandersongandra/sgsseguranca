/* ═══════════════════════════════════════════════════════════════════════════
   ATENÇÃO — ESTE ARQUIVO NÃO É CARREGADO.

   O projeto usa Tailwind v4, onde a configuração vem de CSS e não de JS.
   `app/globals.css` faz `@import "tailwindcss"` SEM bloco `@theme` e SEM
   diretiva `@config`, portanto este arquivo é ignorado pelo build.

   Consequência prática: qualquer utilitário declarado APENAS aqui
   (`bg-ds-primary`, `text-foreground`, `bg-card`, `border-border`, …) gera
   ZERO CSS. Classes assim renderizam sem cor nenhuma, silenciosamente.

   Fonte de verdade dos tokens:
     - styles/tokens.css       (escala bruta)
     - styles/theme-light.css  (camada semântica --ds-color-*)

   Forma correta de consumir, usada no resto do app:
     text-[var(--ds-color-text-primary)]
     bg-[var(--ds-color-surface-elevated)]
     border-[var(--ds-color-border-subtle)]

   Mantido no repositório apenas como referência do mapeamento de tokens.
   Para reativá-lo seria preciso adicionar `@config "../tailwind.config.ts";`
   em globals.css — ou, preferencialmente, migrar para um bloco `@theme`.
   ═══════════════════════════════════════════════════════════════════════════ */

import type { Config } from "tailwindcss";

export default {
  content: [
    "./app/**/*.{ts,tsx}",
    "./src/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      /* ─────────────────────────────────────────────────────────────
         Cores do Design System SGS
         Cada token mapeia uma CSS custom property definida em
         styles/tokens.css (escala bruta) e styles/theme-light.css
         (camada semântica única).

         Uso: bg-ds-primary, text-ds-text-secondary, border-ds-border, etc.
         Manter também as chaves legadas (app, brand, border, text, etc.)
         para não quebrar componentes existentes.
      ───────────────────────────────────────────────────────────── */
      colors: {
        /* ── Escala brand bruta (--color-brand-*) ──────────────────
           Uso direto quando necessário (ex: bg-brand-100, text-brand-700).
           Para interação use as classes semânticas ds-* abaixo.
        ──────────────────────────────────────────────────────────── */
        brand: {
          50:  "var(--color-brand-50)",
          100: "var(--color-brand-100)",
          200: "var(--color-brand-200)",
          300: "var(--color-brand-300)",
          400: "var(--color-brand-400)",
          500: "var(--color-brand-500)",
          600: "var(--color-brand-600)",
          700: "var(--color-brand-700)",
          800: "var(--color-brand-800)",
          900: "var(--color-brand-900)",
          /* aliases legacy — convertidos para CSS vars */
          DEFAULT: "var(--ds-color-action-primary)",
          hover:   "var(--ds-color-action-primary-hover)",
          active:  "var(--ds-color-action-primary-active)",
          soft:    "var(--ds-color-primary-subtle)",
        },

        /* ── Escala neutral bruta (--color-neutral-*) ────────────── */
        neutral: {
          50:  "var(--color-neutral-50)",
          100: "var(--color-neutral-100)",
          200: "var(--color-neutral-200)",
          300: "var(--color-neutral-300)",
          400: "var(--color-neutral-400)",
          500: "var(--color-neutral-500)",
          600: "var(--color-neutral-600)",
          700: "var(--color-neutral-700)",
          800: "var(--color-neutral-800)",
          900: "var(--color-neutral-900)",
          /* aliases legacy — convertidos para CSS vars */
          badge:    "var(--component-badge-neutral-bg)",
          disabled: "var(--ds-color-surface-muted)",
        },

        /* ── Tokens semânticos — preferir estes em código novo ─────
           Mapeiam para as variáveis visuais institucionais.
        ──────────────────────────────────────────────────────────── */
        "ds-primary":   "var(--ds-color-action-primary)",
        "ds-primary-hover": "var(--ds-color-action-primary-hover)",
        "ds-primary-active": "var(--ds-color-action-primary-active)",
        "ds-primary-subtle": "var(--ds-color-primary-subtle)",
        "ds-primary-foreground": "var(--ds-color-action-primary-foreground)",

        "ds-secondary": "var(--ds-color-action-secondary)",
        "ds-secondary-hover": "var(--ds-color-action-secondary-hover)",
        "ds-secondary-foreground": "var(--ds-color-action-secondary-foreground)",

        "ds-bg":        "var(--ds-color-bg-canvas)",
        "ds-bg-subtle": "var(--ds-color-bg-subtle)",
        "ds-surface":   "var(--ds-color-surface-base)",
        "ds-surface-elevated": "var(--ds-color-surface-elevated)",
        "ds-surface-muted": "var(--ds-color-surface-muted)",
        "ds-surface-overlay": "var(--ds-color-surface-overlay)",

        "ds-border":        "var(--ds-color-border-default)",
        "ds-border-subtle": "var(--ds-color-border-subtle)",
        "ds-border-strong": "var(--ds-color-border-strong)",

        "ds-text":          "var(--ds-color-text-primary)",
        "ds-text-secondary": "var(--ds-color-text-secondary)",
        "ds-text-muted":    "var(--ds-color-text-muted)",
        "ds-text-disabled": "var(--ds-color-text-disabled)",
        "ds-text-inverse":  "var(--ds-color-text-inverse)",

        "ds-success":        "var(--ds-color-success)",
        "ds-success-subtle": "var(--ds-color-success-subtle)",
        "ds-success-border": "var(--ds-color-success-border)",
        "ds-success-fg":     "var(--ds-color-success-fg)",

        "ds-warning":        "var(--ds-color-warning)",
        "ds-warning-subtle": "var(--ds-color-warning-subtle)",
        "ds-warning-border": "var(--ds-color-warning-border)",
        "ds-warning-fg":     "var(--ds-color-warning-fg)",

        "ds-danger":         "var(--ds-color-danger)",
        "ds-danger-subtle":  "var(--ds-color-danger-subtle)",
        "ds-danger-border":  "var(--ds-color-danger-border)",
        "ds-danger-fg":      "var(--ds-color-danger-fg)",

        "ds-info":           "var(--ds-color-info)",
        "ds-info-subtle":    "var(--ds-color-info-subtle)",
        "ds-info-border":    "var(--ds-color-info-border)",
        "ds-info-fg":        "var(--ds-color-info-fg)",

        "ds-accent":         "var(--ds-color-accent)",
        "ds-accent-subtle":  "var(--ds-color-accent-subtle)",

        "ds-focus":      "var(--ds-color-focus)",
        "ds-focus-ring": "var(--ds-color-focus-ring)",

        /* ── Alias legados — mantidos para não quebrar código antigo ─
           Convertidos para CSS vars da interface institucional clara.
        ──────────────────────────────────────────────────────────── */
        app: {
          bg:              "var(--ds-color-bg-canvas)",
          subtle:          "var(--ds-color-bg-subtle)",
          surface:         "var(--ds-color-surface-base)",
          "surface-muted": "var(--ds-color-surface-muted)",
          sidebar:         "var(--ds-color-sidebar-bg)",
        },
        border: {
          DEFAULT: "var(--ds-color-border-default)",
          strong:  "var(--ds-color-border-strong)",
        },
        text: {
          title:     "var(--ds-color-text-primary)",
          primary:   "var(--ds-color-text-primary)",
          secondary: "var(--ds-color-text-secondary)",
          muted:     "var(--ds-color-text-muted)",
        },
        success: {
          DEFAULT: "var(--ds-color-success)",
          soft:    "var(--ds-color-success-subtle)",
        },
        warning: {
          DEFAULT: "var(--ds-color-warning)",
          soft:    "var(--ds-color-warning-subtle)",
        },
        danger: {
          DEFAULT: "var(--ds-color-danger)",
          soft:    "var(--ds-color-danger-subtle)",
        },
        info: {
          DEFAULT: "var(--ds-color-info)",
          soft:    "var(--ds-color-info-subtle)",
        },
        table: {
          header: "var(--component-table-header-bg)",
          hover:  "var(--component-table-row-hover)",
        },
        focus: "var(--ds-color-focus)",
      },

      /* ─────────────────────────────────────────────────────────────
         Border Radius — mapeia --ds-radius-* para uso via Tailwind
         Ex: rounded-ds-sm, rounded-ds-md, rounded-ds-lg, rounded-ds-xl
      ───────────────────────────────────────────────────────────── */
      borderRadius: {
        "ds-sm":   "var(--ds-radius-sm)",
        "ds-md":   "var(--ds-radius-md)",
        "ds-lg":   "var(--ds-radius-lg)",
        "ds-xl":   "var(--ds-radius-xl)",
        "ds-full": "var(--ds-radius-full)",
        /* alias legado */
        xl2: "1rem",
      },

      /* ─────────────────────────────────────────────────────────────
         Box Shadow — mapeia --ds-shadow-* para classes Tailwind
         Ex: shadow-ds-xs, shadow-ds-sm, shadow-ds-md, shadow-ds-lg
      ───────────────────────────────────────────────────────────── */
      boxShadow: {
        "ds-xs": "var(--ds-shadow-xs)",
        "ds-sm": "var(--ds-shadow-sm)",
        "ds-md": "var(--ds-shadow-md)",
        "ds-lg": "var(--ds-shadow-lg)",
        "ds-xl": "var(--ds-shadow-xl)",
        /* alias legado */
        soft: "0 1px 2px rgba(15, 23, 42, 0.05), 0 1px 3px rgba(15, 23, 42, 0.08)",
      },

      /* ─────────────────────────────────────────────────────────────
         Font Size — mapeia --ds-text-* para classes Tailwind
         Ex: text-ds-xs, text-ds-sm, text-ds-md, etc.
      ───────────────────────────────────────────────────────────── */
      fontSize: {
        "ds-2xs": ["var(--ds-text-2xs)", { lineHeight: "1.3" }],
        "ds-xs":  ["var(--ds-text-xs)",  { lineHeight: "1.35" }],
        "ds-sm":  ["var(--ds-text-sm)",  { lineHeight: "1.4" }],
        "ds-md":  ["var(--ds-text-md)",  { lineHeight: "var(--ds-line-base)" }],
        "ds-lg":  ["var(--ds-text-lg)",  { lineHeight: "var(--ds-line-tight)" }],
        "ds-xl":  ["var(--ds-text-xl)",  { lineHeight: "var(--ds-line-tight)" }],
        "ds-2xl": ["var(--ds-text-2xl)", { lineHeight: "1.1" }],
        "ds-3xl": ["var(--ds-text-3xl)", { lineHeight: "1.05" }],
      },

      /* ─────────────────────────────────────────────────────────────
         Font Family — mapeia --font-sans e --font-mono
      ───────────────────────────────────────────────────────────── */
      fontFamily: {
        sans: ["var(--font-sans)", "Segoe UI", "Inter", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "Cascadia Mono", "Consolas", "monospace"],
      },

      /* ─────────────────────────────────────────────────────────────
         Transition Duration — mapeia --ds-motion-* para uso direto
         Ex: duration-ds-fast, duration-ds-base, duration-ds-slow
      ───────────────────────────────────────────────────────────── */
      transitionDuration: {
        "ds-fast": "var(--ds-motion-fast)",
        "ds-base": "var(--ds-motion-base)",
        "ds-slow": "var(--ds-motion-slow)",
      },
    },
  },
  plugins: [],
} satisfies Config;
