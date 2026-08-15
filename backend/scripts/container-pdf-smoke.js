#!/usr/bin/env node
/**
 * Smoke de plataforma: Chromium + geração de PDF DENTRO da imagem de runtime.
 *
 * ## Por que este script existe
 *
 * A migração `node:20-bullseye` → `node:22-bookworm` troca o Debian de 11 para
 * 12, e com ele a versão do `chromium` instalada pelo apt. Como o SGS **não**
 * baixa o browser do Puppeteer (`PUPPETEER_SKIP_DOWNLOAD=true` +
 * `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium`), quem renderiza os documentos
 * governados é esse binário do sistema operacional — não o que vem com a
 * biblioteca.
 *
 * Consequência: `npm test` passando na máquina de CI **não diz nada** sobre o
 * browser que roda em produção. A única prova útil é executar dentro da imagem
 * final, como o usuário não-root que o Dockerfile define.
 *
 * ## O que este script prova, e o que não prova
 *
 * PROVA:
 *   - o Chromium do sistema existe, é executável e reporta versão;
 *   - o Puppeteer 25 consegue iniciá-lo com as MESMAS flags de produção;
 *   - uma página renderiza HTML com acentuação, tabela, cabeçalho e rodapé;
 *   - `page.pdf()` devolve um PDF íntegro, parseável, com o número esperado de
 *     páginas e com todos os marcadores obrigatórios presentes no texto;
 *   - nenhum download de browser é disparado durante a execução.
 *
 * NÃO PROVA:
 *   - equivalência VISUAL pixel a pixel com a imagem antiga. Isso exige
 *     rasterizar e comparar as duas imagens, e está deliberadamente fora deste
 *     script. A comparação visual deve ser feita em staging, onde é mais fiel.
 *
 * Uso (dentro do container):
 *   node scripts/container-pdf-smoke.js
 *
 * Sai com código 1 e mensagem explícita no primeiro problema.
 */
'use strict';

const { execFileSync } = require('node:child_process');
const { existsSync } = require('node:fs');

/** Marcadores que o PDF precisa conter. Ausência de qualquer um é falha. */
const MARCADORES = [
  'RELATORIO DE VALIDACAO DE PLATAFORMA',
  'Empresa de Teste Sintetica',
  'Obra Sintetica 01',
  'Análise Preliminar de Risco',
  'Ação corretiva imediata',
  'Responsável técnico',
  'Página 1 de 1',
];

/** Acentuação e cedilha: pegam regressão de fonte/locale entre Debian 11 e 12. */
const ACENTUADOS = ['Análise', 'Ação', 'Responsável', 'notificação', 'ÁÉÍÓÚÇÃÕ'];

function falhar(mensagem) {
  console.error(`\n[FALHA] ${mensagem}\n`);
  process.exit(1);
}

function secao(titulo) {
  console.log(`\n=== ${titulo} ===`);
}

function htmlFixture() {
  // Determinístico de propósito: sem Date.now(), sem IDs aleatórios, sem
  // recursos externos. Se o PDF mudar, foi o renderer que mudou.
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><style>
  @page { size: A4 portrait; margin: 14mm; }
  body { font-family: "DejaVu Sans", "Liberation Sans", Arial, sans-serif; font-size: 10pt; color: #17223b; }
  h1 { font-size: 15pt; margin: 0 0 6mm; }
  table { width: 100%; border-collapse: collapse; margin-top: 4mm; }
  th, td { border: 0.3mm solid #9bb0c9; padding: 2mm; text-align: left; }
  th { background: #eef3f8; }
  .rodape { position: fixed; bottom: 0; width: 100%; font-size: 7pt; color: #5b6b82; }
</style></head><body>
  <h1>RELATORIO DE VALIDACAO DE PLATAFORMA</h1>
  <p><strong>Empresa:</strong> Empresa de Teste Sintetica &nbsp;
     <strong>Obra:</strong> Obra Sintetica 01</p>
  <p>Documento: Análise Preliminar de Risco — fixture determinístico.</p>
  <table>
    <thead><tr><th>Risco</th><th>Severidade</th><th>Medida</th></tr></thead>
    <tbody>
      <tr><td>Queda de altura</td><td>Alta</td><td>Ação corretiva imediata</td></tr>
      <tr><td>Choque elétrico</td><td>Média</td><td>Bloqueio e notificação</td></tr>
    </tbody>
  </table>
  <p style="margin-top:6mm">Responsável técnico: Fulano de Teste</p>
  <p>Acentuação de controle: ÁÉÍÓÚÇÃÕ áéíóúçãõ</p>
  <div class="rodape">Página 1 de 1 — documento sintético, sem valor legal.</div>
</body></html>`;
}

async function main() {
  secao('Ambiente');
  console.log(`node        ${process.version}`);
  console.log(`plataforma  ${process.platform} ${process.arch}`);
  console.log(`usuário     uid=${process.getuid?.() ?? '?'} gid=${process.getgid?.() ?? '?'}`);
  console.log(`TZ          ${process.env.TZ ?? '(não definido)'}`);
  console.log(`LANG        ${process.env.LANG ?? '(não definido)'}`);

  try {
    const os = require('node:fs').readFileSync('/etc/os-release', 'utf8');
    const pretty = /PRETTY_NAME="([^"]+)"/.exec(os);
    console.log(`distro      ${pretty ? pretty[1] : '(desconhecida)'}`);
  } catch {
    console.log('distro      (não foi possível ler /etc/os-release)');
  }

  secao('Chromium do sistema');
  const execPath = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (!execPath) {
    falhar(
      'PUPPETEER_EXECUTABLE_PATH não definida. A imagem deve apontar para o ' +
        'Chromium do sistema — sem ela o Puppeteer tentaria baixar o próprio ' +
        'browser em runtime, que é exatamente o que a estratégia atual evita.',
    );
  }
  if (!existsSync(execPath)) {
    falhar(`PUPPETEER_EXECUTABLE_PATH aponta para caminho inexistente: ${execPath}`);
  }
  console.log(`caminho     ${execPath}`);
  const versaoChromium = execFileSync(execPath, ['--version'], {
    encoding: 'utf8',
  }).trim();
  console.log(`versão      ${versaoChromium}`);

  secao('Puppeteer');
  // O Puppeteer 25 é ESM puro: `require('puppeteer')` falha com
  // "SyntaxError: Unexpected token 'export'". Este script é CommonJS, então o
  // acesso passa pelo import() dinâmico nativo do Node — o mesmo mecanismo que
  // `src/shared/services/puppeteer-runtime.ts` usa em produção.
  const puppeteerModule = await import('puppeteer');
  const puppeteer = puppeteerModule.default ?? puppeteerModule;
  const pkg = JSON.parse(
    require('node:fs').readFileSync(
      require('node:path').join(
        __dirname,
        '..',
        'node_modules',
        'puppeteer',
        'package.json',
      ),
      'utf8',
    ),
  );
  console.log(`puppeteer   ${pkg.version}`);
  if (!pkg.type || pkg.type !== 'module') {
    console.log(
      'aviso: puppeteer não é mais ESM-only; o carregador dinâmico pode ser simplificado',
    );
  }

  // A cadeia vulnerável não pode reaparecer por caminho nenhum.
  try {
    require.resolve('extract-zip');
    falhar(
      'extract-zip está presente em node_modules. A migração para ' +
        '@puppeteer/browsers 3.x deveria tê-lo removido da árvore.',
    );
  } catch (erro) {
    if (erro.code !== 'MODULE_NOT_FOUND') throw erro;
    console.log('extract-zip ausente da árvore (esperado)');
  }

  secao('Launch com as flags de produção');
  // Mesmas flags de puppeteer-pool.service.ts. Copiadas, não importadas, para
  // que este smoke funcione mesmo se o dist/ mudar de forma — e para que uma
  // divergência entre os dois seja visível numa revisão de código.
  const browser = await puppeteer.launch({
    executablePath: execPath,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--disable-extensions',
      '--mute-audio',
      '--disable-background-networking',
      '--disable-crash-reporter',
    ],
  });
  console.log('browser iniciou');

  let pdf;
  const inicio = Date.now();
  try {
    const page = await browser.newPage();
    await page.setContent(htmlFixture(), { waitUntil: 'load' });
    pdf = Buffer.from(
      await page.pdf({ format: 'A4', printBackground: true }),
    );
    await page.close();
  } finally {
    await browser.close();
  }
  const duracaoMs = Date.now() - inicio;
  console.log(`PDF gerado em ${duracaoMs}ms, ${pdf.length} bytes`);

  secao('Integridade do PDF');
  if (pdf.length === 0) falhar('PDF vazio.');
  if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-') {
    falhar(
      `PDF sem magic bytes: recebido "${pdf.subarray(0, 8).toString('latin1')}"`,
    );
  }
  console.log('magic bytes %PDF- presentes');

  // pdf-parse 2.x troca a API de função única (v1) pela classe PDFParse.
  const { PDFParse } = require('pdf-parse');
  const parser = new PDFParse({ data: pdf });
  const parsed = await parser.getText();
  await parser.destroy();
  console.log(`páginas     ${parsed.total}`);
  if (parsed.total !== 1) {
    falhar(
      `Esperava 1 página no fixture, obtive ${parsed.total}. Quebra de ` +
        'página inesperada indica mudança de layout/fonte no renderer.',
    );
  }

  secao('Conteúdo obrigatório');
  const texto = parsed.text.replace(/\s+/g, ' ');
  const faltando = MARCADORES.filter((m) => !texto.includes(m));
  if (faltando.length) {
    falhar(`Marcadores ausentes no PDF: ${faltando.join(' | ')}`);
  }
  console.log(`${MARCADORES.length}/${MARCADORES.length} marcadores presentes`);

  const acentosFaltando = ACENTUADOS.filter((a) => !texto.includes(a));
  if (acentosFaltando.length) {
    falhar(
      `Acentuação perdida no PDF: ${acentosFaltando.join(' | ')}. ` +
        'Provável regressão de fonte ou locale na imagem nova.',
    );
  }
  console.log(`acentuação preservada (${ACENTUADOS.length} amostras)`);

  // Regressão evidente de performance é blocker; ruído de CI não é.
  if (duracaoMs > 30_000) {
    falhar(`Geração levou ${duracaoMs}ms — regressão evidente de performance.`);
  }

  console.log('\n[OK] Chromium e geração de PDF validados dentro do container.');
}

main().catch((erro) => {
  falhar(erro && erro.stack ? erro.stack : String(erro));
});
