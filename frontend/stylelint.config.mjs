const restrictedColorPropertyPattern =
  '/^(color|background|background-color|background-image|border|border-color|outline|outline-color|box-shadow|text-shadow|fill|stroke)$/';

const restrictedLiteralValues = [
  /#([0-9a-fA-F]{3,8})\b/,
  /\brgba?\(/,
  /\bhsla?\(/,
  /\b(?:linear|radial)-gradient\(/,
];

const config = {
  ignoreFiles: [
    '.next/**',
    'out/**',
    'build/**',
    'coverage/**',
    'node_modules/**',
  ],
  customSyntax: 'postcss-scss',
  rules: {
    'color-no-hex': true,
    'function-disallowed-list': ['rgb', 'rgba', 'hsl', 'hsla'],
    'declaration-property-value-disallowed-list': {
      [restrictedColorPropertyPattern]: restrictedLiteralValues,
    },
  },
  overrides: [
    {
      files: [
        'styles/tokens.css',
        'styles/theme-light.css',
        'app/globals.css',
        'app/legal-pages.module.css',
      ],
      rules: {
        'color-no-hex': null,
        'function-disallowed-list': null,
        'declaration-property-value-disallowed-list': null,
      },
    },
  ],
};

export default config;
