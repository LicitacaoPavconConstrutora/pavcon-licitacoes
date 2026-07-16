// =============================================================================
// Cláudio Proxy - ponte entre PavCon (Edge Function) e Claude Code CLI
// =============================================================================
// Roda na máquina do orçamentista (que tem Claude Code Max subscription).
// Expõe um endpoint HTTP que o Edge Function chama via Cloudflare Tunnel.
//
// O proxy executa `claude -p <prompt>` via subprocess e devolve a resposta.
// A subscription Max é usada automaticamente porque o `claude` CLI guarda
// as credenciais OAuth quando o usuário faz login.
//
// Uso:
//   1. Instalar: npm install
//   2. Logar no Claude Code (se ainda não): claude login
//   3. Rodar: npm start (porta 3001 por default, configurável via PORT env)
//   4. Expor publicamente via Cloudflare Tunnel (vide README)
// =============================================================================

import express from 'express';
import cors from 'cors';
import { spawn } from 'child_process';
import { setTimeout as delay } from 'timers/promises';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ajustarValorViaBrowser } from './ajustar-valor.js';

const PORT = process.env.PORT || 3001;
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS || 120000); // 2 min /chat
const EXTRACT_TIMEOUT_MS = Number(process.env.CLAUDE_EXTRACT_TIMEOUT_MS || 600000); // 10 min /extract
const AUTH_TOKEN = process.env.CLAUDIO_PROXY_TOKEN || '';

const app = express();
app.use(cors());
// Limite alto pra aceitar PDFs grandes (até 50MB de base64).
app.use(express.json({ limit: '60mb' }));

// =============================================================================
// Middleware: autenticação opcional via Bearer token
// =============================================================================
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  if (!AUTH_TOKEN) return next(); // sem token configurado, libera (modo dev)
  const auth = req.headers.authorization ?? '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (token !== AUTH_TOKEN) {
    return res.status(401).json({ error: 'Token inválido. Configure Authorization: Bearer <token>.' });
  }
  next();
});

// =============================================================================
// Healthcheck
// =============================================================================
app.get('/health', async (_req, res) => {
  // Verifica se o claude CLI está disponível
  const ok = await new Promise((resolve) => {
    const child = spawn(CLAUDE_BIN, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
  res.json({
    ok,
    timestamp: new Date().toISOString(),
    claude_cli: ok ? 'disponível' : 'não encontrado',
    auth_required: !!AUTH_TOKEN,
  });
});

// =============================================================================
// POST /chat — Recebe pergunta, executa claude CLI, devolve resposta
// =============================================================================
// Body:
//   {
//     "system": "string (system prompt)",
//     "messages": [{role, content}, ...],
//     "max_loops": 8
//   }
//
// Estratégia: como o CLI não tem tool use estruturado fácil de parsear, a
// gente cola system + histórico num único prompt. Tool calls do Cláudio
// vão ser instruídas no system prompt como XML tags que parseamos no
// Edge Function. O CLI só executa um turn por vez.
// =============================================================================
app.post('/chat', async (req, res) => {
  const { system, messages } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages obrigatório (array não vazio).' });
  }

  // Monta o prompt completo a partir das mensagens.
  // O Claude Code CLI aceita system via flag e o resto como prompt input.
  const promptCompleto = messages.map((m) => {
    const role = m.role === 'user' ? 'Human' : 'Assistant';
    const content = typeof m.content === 'string'
      ? m.content
      : JSON.stringify(m.content);
    return `${role}: ${content}`;
  }).join('\n\n');

  // Executa: claude -p "<prompt>" [opções]
  // Flags úteis:
  //   -p / --print: modo headless, retorna stdout
  //   --output-format text|json: formato saída
  //   --append-system-prompt: adiciona ao system padrão
  // Pra ver as opções disponíveis: `claude --help`
  const args = ['--print', '--output-format', 'text'];
  if (system) {
    args.push('--append-system-prompt', system);
  }

  console.log(`[claudio-proxy] chamando claude com ${messages.length} mensagem(ns)`);
  const startedAt = Date.now();

  try {
    const result = await executarClaude(args, promptCompleto);
    const duration = Date.now() - startedAt;
    console.log(`[claudio-proxy] resposta em ${duration}ms (${result.stdout.length} chars)`);
    res.json({
      ok: true,
      resposta: result.stdout.trim(),
      via: 'claude-code-cli',
      duration_ms: duration,
    });
  } catch (e) {
    console.error('[claudio-proxy] erro:', e);
    res.status(500).json({
      error: e instanceof Error ? e.message : String(e),
      duration_ms: Date.now() - startedAt,
    });
  }
});

// =============================================================================
// POST /extract — modo ASYNC (necessário pra contornar timeout 100s do tunnel)
// =============================================================================
// Body: { system, user_intro, pdfs: [{filename, b64}], trailing_instruction }
// Response (200, IMEDIATAMENTE):
//   { ok: true, job_id: "uuid", status: "queued" }
//
// Cliente DEVE fazer polling em GET /extract/:job_id até receber
// status: "done" ou "error". Job permanece em memória por 30 min após
// concluir (limpeza preguiçosa). Em caso de restart do proxy, todos os
// jobs perdem o estado — cliente recebe 404 e deve recomeçar.
//
// Por que async: Cloudflare Quick Tunnel mata HTTP requests em 100s.
// Claude CLI lê PDFs em 3-8 min. Mantendo a conexão aberta dispara 524.
// =============================================================================
const jobs = new Map(); // job_id -> { status, text?, error?, started_at, finished_at?, tmp? }
const JOB_TTL_MS = 30 * 60 * 1000; // 30 min

function limparJobsAntigos() {
  const agora = Date.now();
  for (const [id, job] of jobs.entries()) {
    if (job.finished_at && agora - job.finished_at > JOB_TTL_MS) {
      jobs.delete(id);
    }
  }
}
setInterval(limparJobsAntigos, 5 * 60 * 1000); // a cada 5 min

app.post('/extract', async (req, res) => {
  const { system, user_intro, pdfs, trailing_instruction, callback_url, callback_token } = req.body || {};
  if (!Array.isArray(pdfs) || pdfs.length === 0) {
    return res.status(400).json({ error: 'pdfs obrigatório (array não vazio com {filename, b64}).' });
  }

  const jobId = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const startedAt = Date.now();
  jobs.set(jobId, { status: 'running', started_at: startedAt, callback_url, callback_token });

  // Responde IMEDIATAMENTE com o job_id pra evitar timeout do tunnel
  res.json({ ok: true, job_id: jobId, status: 'queued' });

  // Executa em background — não tem mais request pra timeoutar
  (async () => {
    let tmp;
    try {
      tmp = await mkdtemp(join(tmpdir(), 'claudio-extract-'));
      jobs.get(jobId).tmp = tmp;
      console.log(`[claudio-proxy] /extract job=${jobId}: ${pdfs.length} PDF(s) em ${tmp}`);

      const writtenFiles = [];
      for (let i = 0; i < pdfs.length; i++) {
        const safeFilename = (pdfs[i].filename ?? `arquivo_${i + 1}.pdf`)
          .replace(/[^\w.-]/g, '_')
          .slice(0, 80);
        const fpath = join(tmp, safeFilename);
        const buf = Buffer.from(pdfs[i].b64, 'base64');
        await writeFile(fpath, buf);
        writtenFiles.push(safeFilename);
      }

      const partes = [];
      if (user_intro) partes.push(user_intro);
      partes.push(
        `Os seguintes PDFs estão disponíveis no diretório atual. ` +
        `Use a tool Read pra ler CADA UM antes de produzir o JSON:`,
      );
      partes.push(writtenFiles.map((f, i) => `  ${i + 1}. ${f}`).join('\n'));
      if (trailing_instruction) partes.push(trailing_instruction);
      const promptCompleto = partes.join('\n\n');

      const args = ['--print', '--output-format', 'text'];
      if (system) args.push('--append-system-prompt', system);

      const result = await executarClaude(args, promptCompleto, {
        cwd: tmp,
        timeoutMs: EXTRACT_TIMEOUT_MS,
      });
      const duration = Date.now() - startedAt;
      console.log(`[claudio-proxy] job=${jobId} OK em ${(duration / 1000).toFixed(1)}s (${result.stdout.length} chars)`);
      const job = jobs.get(jobId);
      if (job) {
        job.status = 'done';
        job.text = result.stdout.trim();
        job.duration_ms = duration;
        job.finished_at = Date.now();
        await notifyCallback(jobId, job);
      }
    } catch (e) {
      console.error(`[claudio-proxy] job=${jobId} erro:`, e);
      const job = jobs.get(jobId);
      if (job) {
        job.status = 'error';
        job.error = e instanceof Error ? e.message : String(e);
        job.finished_at = Date.now();
        await notifyCallback(jobId, job);
      }
    } finally {
      if (tmp) try { await rm(tmp, { recursive: true, force: true }); } catch {}
    }
  })();
});

// =============================================================================
// POST /ajustar-valor — "Forçar total" via automação de navegador (Playwright)
// =============================================================================
// Body:
//   {
//     "budget_id": "24 hex chars do orçamento no Orçafascio",
//     "valor_final": 1300162.01,
//     "cookie_header": "sessão já autenticada (session.cookie_header)",
//     "dry_run": false   // true = preenche mas não submete (validação visual)
//   }
//
// Existe pq a chamada HTTP direta ao endpoint interno do Orçafascio já
// corrompeu orçamentos reais 2x (ver supabase/functions/_shared/
// orcafascio-web-v2023.ts). Esta versão abre um Chromium de verdade e
// clica/preenche o formulário real — não adivinha o "recipe" da API.
//
// NÃO TESTADO CONTRA O SITE REAL — rode com dry_run:true num orçamento de
// TESTE primeiro e confira os screenshots (base64 PNG) na resposta antes
// de confiar em dry_run:false num orçamento real. Vide comentários em
// ajustar-valor.js pra como ajustar os seletores se algo não bater.
// =============================================================================
app.post('/ajustar-valor', async (req, res) => {
  const { budget_id, valor_final, cookie_header, dry_run } = req.body || {};
  if (!budget_id) return res.status(400).json({ error: 'budget_id obrigatório.' });
  if (!Number.isFinite(valor_final) || valor_final <= 0) {
    return res.status(400).json({ error: `valor_final inválido: ${valor_final}` });
  }
  if (!cookie_header) return res.status(400).json({ error: 'cookie_header obrigatório.' });

  console.log(`[claudio-proxy] /ajustar-valor budget=${budget_id} valor=${valor_final} dry_run=${!!dry_run}`);
  const startedAt = Date.now();
  try {
    const resultado = await ajustarValorViaBrowser({
      budgetId: budget_id,
      valorFinal: valor_final,
      cookieHeader: cookie_header,
      dryRun: !!dry_run,
    });
    console.log(`[claudio-proxy] /ajustar-valor ${resultado.ok ? 'OK' : 'FALHOU'} em ${Date.now() - startedAt}ms — passos: ${(resultado.passos ?? []).join(', ')}`);
    res.json({ ...resultado, duration_ms: Date.now() - startedAt });
  } catch (e) {
    console.error('[claudio-proxy] /ajustar-valor erro:', e);
    res.status(500).json({
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      duration_ms: Date.now() - startedAt,
    });
  }
});

// =============================================================================
// Notifica callback_url quando job termina (substitui polling)
// =============================================================================
async function notifyCallback(jobId, job) {
  if (!job.callback_url) return;
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (job.callback_token) headers['Authorization'] = `Bearer ${job.callback_token}`;
    const body = {
      job_id: jobId,
      status: job.status,
      text: job.text,
      error: job.error,
      duration_ms: job.duration_ms,
    };
    const resp = await fetch(job.callback_url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    console.log(`[claudio-proxy] job=${jobId} callback ${job.callback_url.slice(0, 60)} → ${resp.status}`);
  } catch (e) {
    console.error(`[claudio-proxy] job=${jobId} callback falhou:`, e);
  }
}

// =============================================================================
// GET /extract/:job_id — polling pra cliente saber o status
// =============================================================================
// Response:
//   200 { ok, status: "queued|running|done|error", text?, error?, duration_ms? }
//   404 { error: "job não encontrado (expirou ou nunca existiu)" }
// =============================================================================
app.get('/extract/:job_id', (req, res) => {
  const job = jobs.get(req.params.job_id);
  if (!job) {
    return res.status(404).json({ error: 'job não encontrado (expirou ou nunca existiu).' });
  }
  res.json({
    ok: true,
    status: job.status,
    text: job.text,
    error: job.error,
    duration_ms: job.duration_ms,
    started_at: new Date(job.started_at).toISOString(),
    finished_at: job.finished_at ? new Date(job.finished_at).toISOString() : null,
  });
});

// =============================================================================
// Helper: executa CLI claude com timeout
// =============================================================================
function executarClaude(args, stdinInput, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const proc = spawn(CLAUDE_BIN, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
      cwd: opts.cwd, // undefined → diretório atual (default)
    });

    let stdout = '';
    let stderr = '';
    let finalizado = false;

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('error', (err) => {
      if (finalizado) return;
      finalizado = true;
      reject(new Error(`Falha ao executar ${CLAUDE_BIN}: ${err.message}. Instalado? Logado? Tenta 'claude --version' e 'claude login' no terminal.`));
    });

    proc.on('close', (code) => {
      if (finalizado) return;
      finalizado = true;
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`claude CLI exit ${code}: ${stderr.slice(0, 500) || stdout.slice(0, 500)}`));
      }
    });

    // Envia o prompt via stdin
    if (stdinInput) {
      proc.stdin.write(stdinInput);
      proc.stdin.end();
    } else {
      proc.stdin.end();
    }

    // Timeout (configurável: /chat usa TIMEOUT_MS, /extract usa EXTRACT_TIMEOUT_MS)
    (async () => {
      await delay(timeoutMs);
      if (!finalizado) {
        finalizado = true;
        proc.kill('SIGTERM');
        reject(new Error(`Timeout (${timeoutMs}ms) — claude CLI travou ou levou demais.`));
      }
    })();
  });
}

// =============================================================================
// Start
// =============================================================================
app.listen(PORT, () => {
  console.log('');
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║                    🤖 Cláudio Proxy                         ║');
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log(`║  Porta: ${String(PORT).padEnd(50)}║`);
  console.log(`║  CLI:   ${CLAUDE_BIN.padEnd(50)}║`);
  console.log(`║  Auth:  ${(AUTH_TOKEN ? 'token configurado' : 'desativada (modo dev)').padEnd(50)}║`);
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log('║  Healthcheck:   http://localhost:' + PORT + '/health                ║');
  console.log('║  Chat:          POST http://localhost:' + PORT + '/chat            ║');
  console.log('║  Extract:       POST http://localhost:' + PORT + '/extract         ║');
  console.log('║  Ajustar valor: POST http://localhost:' + PORT + '/ajustar-valor   ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('Próximo passo: expor publicamente via Cloudflare Tunnel.');
  console.log('Vide README.md pra setup.');
  console.log('');
});
