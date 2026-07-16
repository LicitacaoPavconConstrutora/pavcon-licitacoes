// =============================================================================
// Ajustar Valor via automação de navegador (Playwright)
// =============================================================================
// Por que isso existe: a chamada direta ao endpoint HTTP interno do
// Orçafascio (`ajustar_valor_passo_1` + `ajustar_valor_passo_2` via fetch)
// já corrompeu orçamentos reais DUAS vezes (ver supabase/functions/_shared/
// orcafascio-web-v2023.ts e o commit 42f4d8d). Root cause provável: as
// tentativas anteriores ADIVINHARAM a sequência de campos/URLs em vez de
// reproduzir o que o navegador real faz.
//
// Esta versão não adivinha nada: abre um Chromium de verdade, injeta a
// sessão (cookies) que o Edge Function já autenticou, e clica/preenche o
// formulário REAL exatamente como um humano faria. O próprio Rails cuida
// de CSRF/estado de sessão — a gente não replica isso manualmente.
//
// ATENÇÃO — NÃO TESTADO CONTRA O SITE REAL (escrito num ambiente sem
// acesso de rede ao Orçafascio). ANTES de usar em qualquer orçamento real:
//   1. Rode com `dryRun: true` num orçamento de TESTE e confira os
//      screenshots retornados (budget_antes, form_ajustar_valor,
//      form_preenchido) pra confirmar que os seletores acharam os
//      elementos certos.
//   2. Só depois disso rode com `dryRun: false`.
// Se os seletores não baterem com o HTML real, ajuste as listas
// `EDITAR_LINK_TEXTS` / `AJUSTAR_VALOR_LINK_TEXTS` / `SUBMIT_BUTTON_TEXTS`
// abaixo com base no que aparecer nos screenshots.
// =============================================================================

import { chromium } from 'playwright';

const BASE = 'https://app.orcafascio.com';

// Textos candidatos pros elementos clicáveis — em ordem de tentativa.
// Ajuste aqui se o screenshot mostrar rótulos diferentes.
const EDITAR_LINK_TEXTS = ['Editar'];
const AJUSTAR_VALOR_LINK_TEXTS = ['Ajustar valor', 'Ajustar Valor'];
const SUBMIT_BUTTON_TEXTS = ['Confirmar', 'Aplicar', 'Ajustar', 'Salvar', 'OK', 'Enviar'];

// Seletores ESPECÍFICOS pro campo de valor final — se um destes achar o
// elemento, confiamos e seguimos (mesmo em dryRun:false).
const FINAL_PRICE_INPUT_SELECTORS_ESPECIFICOS = [
  'input[name="final_price"]',
  'input#final_price',
  'input[name*="final_price" i]',
];
// Fallback GENÉRICO — só serve pra dryRun (screenshot pra ajuste manual dos
// seletores). NUNCA usado pra submeter de verdade: um input[type=text] ou
// [type=number] genérico pode ser QUALQUER campo da página (busca,
// quantidade, etc), não necessariamente o valor final. Ver
// `findFinalPriceInput` — a confiança retornada decide se pode submeter.
const FINAL_PRICE_INPUT_SELECTORS_GENERICOS = [
  'input[type="text"]',
  'input[type="number"]',
];

function parseCookieHeader(cookieHeader) {
  return cookieHeader
    .split(';')
    .map((pair) => {
      const idx = pair.indexOf('=');
      if (idx === -1) return null;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (!name) return null;
      return { name, value, domain: 'app.orcafascio.com', path: '/' };
    })
    .filter(Boolean);
}

function formatBRL(value) {
  return value.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.exigirUnico] - se true, recusa clicar quando o texto
 *        bate em MAIS DE UM elemento na página (ambíguo — ex: vários links
 *        "Editar", um por linha do orçamento). Em vez de arriscar `.first()`
 *        clicar no elemento errado, retorna false pro caller cair no
 *        fallback (navegação direta por URL).
 */
async function clickByText(page, texts, { timeout = 4000, exigirUnico = false } = {}) {
  for (const text of texts) {
    const loc = page.getByText(text, { exact: false });
    try {
      const count = await loc.count();
      if (count === 0) continue;
      if (exigirUnico && count > 1) continue; // ambíguo — tenta próximo texto/fallback
      await loc.first().click({ timeout });
      return true;
    } catch {
      // tenta o próximo texto
    }
  }
  return false;
}

/**
 * Acha o campo de valor final. Retorna `{ locator, confianca }` onde
 * `confianca` é:
 *   'especifico' — bateu num seletor que só existe se for o campo certo
 *                  (name/id contendo "final_price"). Seguro pra submeter.
 *   'generico'   — só achou via fallback genérico (qualquer input de texto/
 *                  número). NÃO é seguro submeter — pode ser um campo
 *                  qualquer da página. Só serve pra screenshot de dryRun,
 *                  pra quem for ajustar os seletores acima ver o que tem
 *                  na tela.
 * Retorna `null` se não achou nada.
 */
async function findFinalPriceInput(page) {
  for (const sel of FINAL_PRICE_INPUT_SELECTORS_ESPECIFICOS) {
    const loc = page.locator(sel).first();
    if ((await loc.count()) > 0) return { locator: loc, confianca: 'especifico' };
  }
  for (const sel of FINAL_PRICE_INPUT_SELECTORS_GENERICOS) {
    const loc = page.locator(sel).first();
    if ((await loc.count()) > 0) return { locator: loc, confianca: 'generico' };
  }
  return null;
}

/**
 * Ajusta o valor final do orçamento no Orçafascio via automação de navegador.
 *
 * @param {object} params
 * @param {string} params.budgetId - ID do orçamento no Orçafascio (24 hex chars).
 * @param {number} params.valorFinal - Valor total desejado (com BDI).
 * @param {string} params.cookieHeader - Cookie header da sessão já autenticada
 *        (o mesmo `session.cookie_header` usado pelas chamadas HTTP diretas).
 * @param {boolean} [params.dryRun=false] - Se true, preenche o form mas NÃO
 *        submete. Use isso na primeira execução pra validar visualmente.
 */
export async function ajustarValorViaBrowser({ budgetId, valorFinal, cookieHeader, dryRun = false }) {
  if (!budgetId) throw new Error('budgetId obrigatório.');
  if (!Number.isFinite(valorFinal) || valorFinal <= 0) {
    throw new Error(`valorFinal inválido: ${valorFinal}`);
  }
  if (!cookieHeader) throw new Error('cookieHeader obrigatório (sessão do Orçafascio).');

  const browser = await chromium.launch({ headless: true });
  const screenshots = {};
  const passos = [];

  try {
    const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    await context.addCookies(parseCookieHeader(cookieHeader));
    const page = await context.newPage();

    // ---- 1) Abre o orçamento — confirma que a sessão é válida ----------------
    const budgetUrl = `${BASE}/orc/orcamentos/${budgetId}`;
    await page.goto(budgetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (page.url().includes('/login')) {
      throw new Error('Sessão do Orçafascio expirada/inválida (redirecionado pro login ao abrir o orçamento).');
    }
    screenshots.budget_antes = await page.screenshot({ encoding: 'base64', fullPage: false });
    passos.push('budget_aberto');

    // ---- 2) Tenta o caminho "Editar → Ajustar valor" (igual um humano) ------
    // exigirUnico:true no "Editar": uma página de orçamento provavelmente
    // tem vários links "Editar" (um por linha/item) — clicar no primeiro
    // que aparecer pode levar pro lugar errado. Se for ambíguo, cai pro
    // fallback de navegação direta por URL em vez de arriscar.
    let chegouNoForm = false;
    if (await clickByText(page, EDITAR_LINK_TEXTS, { exigirUnico: true })) {
      passos.push('clicou_editar');
      await page.waitForTimeout(500);
      if (await clickByText(page, AJUSTAR_VALOR_LINK_TEXTS)) {
        passos.push('clicou_ajustar_valor');
        chegouNoForm = true;
      }
    }

    // ---- 2b) Fallback: navega direto pra URL do passo_1 ----------------------
    if (!chegouNoForm) {
      const passo1Url = `${BASE}/v2023/orc/orcamentos/${budgetId}/ajustar_valor_passo_1`;
      await page.goto(passo1Url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      passos.push('navegou_direto_passo_1');
      if (page.url().includes('/login')) {
        throw new Error('Sessão expirou ao tentar abrir o form de ajustar valor diretamente.');
      }
    }
    await page.waitForTimeout(500);
    screenshots.form_ajustar_valor = await page.screenshot({ encoding: 'base64', fullPage: false });

    // ---- 3) Preenche o campo de valor final -----------------------------------
    const achado = await findFinalPriceInput(page);
    if (!achado) {
      return {
        ok: false,
        error: 'Não encontrei o campo de valor final na tela. Confira os screenshots e ajuste FINAL_PRICE_INPUT_SELECTORS_ESPECIFICOS.',
        passos,
        screenshots,
      };
    }
    const { locator: input, confianca } = achado;
    await input.fill(valorFinal.toFixed(2));
    screenshots.form_preenchido = await page.screenshot({ encoding: 'base64', fullPage: false });
    passos.push(`form_preenchido(confianca=${confianca})`);

    if (dryRun) {
      return { ok: true, dry_run: true, confianca_campo: confianca, passos, screenshots };
    }

    // SEGURANÇA: nunca submete de verdade se o campo só foi achado pelo
    // fallback genérico (pode ser QUALQUER input da página, não
    // necessariamente o valor final). Força o caller a tratar isso como um
    // dry-run — precisa ajustar FINAL_PRICE_INPUT_SELECTORS_ESPECIFICOS
    // primeiro (olhando o screenshot form_preenchido) antes de confiar.
    if (confianca === 'generico') {
      return {
        ok: false,
        dry_run: true,
        error:
          'Campo de valor final só foi achado via seletor GENÉRICO (não confiável pra submeter). ' +
          'Confira o screenshot form_preenchido e ajuste FINAL_PRICE_INPUT_SELECTORS_ESPECIFICOS em ' +
          'ajustar-valor.js antes de tentar de novo.',
        confianca_campo: confianca,
        passos,
        screenshots,
      };
    }

    // ---- 4) Submete -----------------------------------------------------------
    const submeteu = await clickByText(page, SUBMIT_BUTTON_TEXTS, { timeout: 5000 });
    if (!submeteu) {
      await input.press('Enter').catch(() => {});
    }
    passos.push(submeteu ? 'clicou_submit' : 'submeteu_via_enter');
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    screenshots.apos_submit = await page.screenshot({ encoding: 'base64', fullPage: false });

    // ---- 5) Reabre o orçamento e tenta confirmar visualmente -------------------
    await page.goto(budgetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (page.url().includes('/login')) {
      return {
        ok: false,
        error: 'Sessão expirou depois do submit — não deu pra confirmar o resultado. CONFIRA MANUALMENTE no Orçafascio antes de considerar aplicado.',
        passos,
        screenshots,
      };
    }
    screenshots.budget_depois = await page.screenshot({ encoding: 'base64', fullPage: false });
    const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');
    const valorFormatado = formatBRL(valorFinal);
    const totalConfereNaPagina = bodyText.includes(valorFormatado);
    passos.push('verificacao_final');

    return {
      ok: true,
      dry_run: false,
      total_confere_na_pagina: totalConfereNaPagina,
      valor_esperado_formatado: valorFormatado,
      aviso: totalConfereNaPagina
        ? undefined
        : `Não encontrei "${valorFormatado}" no texto da página depois do ajuste — CONFIRA MANUALMENTE no Orçafascio, pode não ter aplicado.`,
      passos,
      screenshots,
    };
  } finally {
    await browser.close();
  }
}
