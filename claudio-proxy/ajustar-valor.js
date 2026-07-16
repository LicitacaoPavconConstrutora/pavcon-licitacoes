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
const FINAL_PRICE_INPUT_SELECTORS = [
  'input[name="final_price"]',
  'input#final_price',
  'input[name*="final_price" i]',
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

async function clickByText(page, texts, { timeout = 4000 } = {}) {
  for (const text of texts) {
    const loc = page.getByText(text, { exact: false }).first();
    try {
      if ((await loc.count()) > 0) {
        await loc.click({ timeout });
        return true;
      }
    } catch {
      // tenta o próximo texto
    }
  }
  return false;
}

async function findFinalPriceInput(page) {
  for (const sel of FINAL_PRICE_INPUT_SELECTORS) {
    const loc = page.locator(sel).first();
    if ((await loc.count()) > 0) return loc;
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
    let chegouNoForm = false;
    if (await clickByText(page, EDITAR_LINK_TEXTS)) {
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
    const input = await findFinalPriceInput(page);
    if (!input) {
      return {
        ok: false,
        error: 'Não encontrei o campo de valor final na tela. Confira os screenshots e ajuste FINAL_PRICE_INPUT_SELECTORS.',
        passos,
        screenshots,
      };
    }
    await input.fill(valorFinal.toFixed(2));
    screenshots.form_preenchido = await page.screenshot({ encoding: 'base64', fullPage: false });
    passos.push('form_preenchido');

    if (dryRun) {
      return { ok: true, dry_run: true, passos, screenshots };
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
