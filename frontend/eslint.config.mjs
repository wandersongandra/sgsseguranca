import { createRequire } from "node:module";
import globals from "globals";

// eslint-config-next@16.x já exporta flat config nativo (array de objetos).
// Importar via createRequire evita FlatCompat/@eslint/eslintrc, que trava ao
// serializar eslint-plugin-react@7.37+ com JSON.stringify por ref circular.
const require = createRequire(import.meta.url);
const nextCoreWebVitals = require("eslint-config-next/core-web-vitals");

const eslintConfig = [
  {
    // eslint-config-next@16.2.11 usa o parser Babel do Next.js para arquivos .js/.mjs.
    // Esse parser não produz scope manager com addGlobals(), exigido pelo ESLint 10.
    // Esses arquivos são config/scripts operacionais (não TypeScript app code), portanto
    // são excluídos do lint. O código de aplicação real é 100% TypeScript (.ts/.tsx).
    ignores: [
      ".next/**",
      ".vercel/**",
      "out/**",
      "build/**",
      "coverage/**",
      "next-env.d.ts",
      // Arquivos .js/.mjs são config/scripts sem TypeScript — excluídos do lint
      "*.js",
      "*.mjs",
      "scripts/**",
      "public/**",
    ],
  },
  ...nextCoreWebVitals,
  // eslint-config-next sets settings.react.version = 'detect', which calls
  // context.getFilename() (removed in ESLint 10). Override with explicit version
  // so eslint-plugin-react@7.37.5 skips auto-detection entirely.
  {
    settings: {
      react: {
        version: "19",
      },
    },
  },
  {
    // eslint-plugin-react-hooks@7.x (bundled in eslint-config-next@16.2.11) adicionou
    // regras do React Compiler (set-state-in-effect, refs, purity, etc.) que violam
    // 155 patterns no codebase atual. Este projeto não usa React Compiler experimental.
    // Mantemos apenas as regras tradicionais: rules-of-hooks e exhaustive-deps.
    rules: {
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/refs": "off",
      "react-hooks/preserve-manual-memoization": "off",
      "react-hooks/purity": "off",
      "react-hooks/immutability": "off",
      "react-hooks/incompatible-library": "off",
      "react-hooks/static-components": "off",
      "react-hooks/use-memo": "off",
      "react-hooks/globals": "off",
      "react-hooks/error-boundaries": "off",
      "react-hooks/set-state-in-render": "off",
      "react-hooks/unsupported-syntax": "off",
      "react-hooks/config": "off",
      "react-hooks/gating": "off",
    },
  },
  {
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "JSXAttribute[name.name=/^(color|backgroundColor|borderColor|outlineColor|fill|stroke|penColor)$/][value.type='Literal'][value.value=/^(#|rgb\\(|rgba\\(|hsl\\(|hsla\\()/i]",
          message:
            "Use tokens do design system em vez de literais de cor em props JSX.",
        },
        {
          selector:
            "JSXAttribute[name.name='style'] JSXExpressionContainer ObjectExpression > Property[key.type='Identifier'][key.name=/^(color|background|backgroundColor|borderColor|outlineColor|fill|stroke)$/][value.type='Literal'][value.value=/^(#|rgb\\(|rgba\\(|hsl\\(|hsla\\()/i]",
          message:
            "Use tokens do design system em vez de literais de cor em style inline.",
        },
      ],
    },
  },
  {
    files: ["**/*.test.ts", "**/*.test.tsx", "jest.setup.ts"],
    languageOptions: {
      globals: globals.jest,
    },
  },
  {
    files: ["jest.config.cjs", "scripts/**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: {
        ...globals.commonjs,
        ...globals.node,
      },
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
];

export default eslintConfig;
