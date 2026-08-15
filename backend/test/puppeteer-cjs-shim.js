'use strict';

/**
 * Shim CJS para 'puppeteer' dentro do Jest.
 *
 * Mesmo problema do uuid-cjs.js ao lado: Puppeteer 25 e' ESM puro
 * ("type": "module"). Com NODE_OPTIONS=--experimental-vm-modules ativo
 * (necessario para pdf-parse/pdfjs-dist funcionar em teste — ver
 * scripts/run-jest.cjs), o Jest passa a tratar QUALQUER require('puppeteer')
 * pelo seu proprio carregador nativo de VM Modules, cujas APIs sincronas
 * exigem Node >=24.9. Sob Node 22 (a versao desta plataforma), isso falha
 * com "Jest's require(ESM) requires Node v24.9+ for synchronous vm module
 * APIs".
 *
 * A saida: interceptar 'puppeteer' via moduleNameMapper ANTES que o Jest
 * chegue a resolver o pacote real — o require('puppeteer') do codigo da
 * aplicacao carrega ESTE arquivo (puro CJS, sem "type":"module" no
 * package.json mais proximo), nunca o pacote puppeteer em si. Dentro dele,
 * o pacote real e' carregado sob demanda via import() dinamico nativo do
 * Node, que resolve corretamente pacotes ESM a partir de CommonJS
 * independente da flag --experimental-vm-modules (essa flag afeta como o
 * JEST decide carregar um modulo; nao afeta o import() nativo do proprio
 * Node quando chamado de dentro de codigo ja em execucao).
 *
 * `new Function` e' proposital: esconde o import() do downlevel que o
 * TypeScript faria para require() sob module:commonjs (recriando o mesmo
 * problema). Aqui o arquivo ja e' JS puro, mas o padrao e' mantido por
 * consistencia e porque builds futuros nao devem reintroduzir o problema
 * por engano.
 */

let modulePromise = null;

function loadRealPuppeteer() {
  if (!modulePromise) {
    // eslint-disable-next-line no-new-func
    const dynamicImport = new Function(
      'specifier',
      'return import(specifier)',
    );
    modulePromise = dynamicImport('puppeteer').then((mod) => mod.default ?? mod);
  }
  return modulePromise;
}

module.exports = {
  launch(options) {
    return loadRealPuppeteer().then((puppeteer) => puppeteer.launch(options));
  },
  executablePath() {
    return loadRealPuppeteer().then((puppeteer) => puppeteer.executablePath());
  },
};
