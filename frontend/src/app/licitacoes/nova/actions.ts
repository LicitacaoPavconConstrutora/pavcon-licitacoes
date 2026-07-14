'use server';

import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { redirect } from 'next/navigation';
import { otimizarPdfs } from '../[id]/actions';

interface ActionResult {
  error?: string;
  licitacao_id?: string;
}

const TIPOS_VALIDOS = new Set([
  'planilha_orcamentaria',
  'memorial_descritivo',
  'projeto_tecnico',
  'edital',
  'anexo',
]);

interface ArquivoUploaded {
  storage_path: string;
  filename: string;
  size: number;
  mime_type: string;
  hash_sha256: string;
  tipo: string;
}

/**
 * Cria licitação a partir de arquivos JÁ UPLOADADOS pelo cliente direto
 * no Supabase Storage. Server action só recebe metadata (pequena), evitando
 * o limite de 4.5MB de payload das Vercel Serverless Functions.
 *
 * O cliente é responsável por:
 *  1. Validar tipo MIME e tamanho
 *  2. Calcular SHA-256 (file ainda em memória)
 *  3. Upload via supabase.storage.from('editais').upload(...)
 *  4. Chamar essa action com o path retornado
 */
export async function createLicitacao(input: {
  titulo: string;
  arquivos: ArquivoUploaded[];
}): Promise<ActionResult> {
  const titulo = (input.titulo ?? '').trim();
  const arquivos = input.arquivos ?? [];

  if (!titulo) return { error: 'Título é obrigatório.' };
  if (arquivos.length === 0) return { error: 'Selecione pelo menos 1 PDF.' };

  for (let i = 0; i < arquivos.length; i++) {
    const a = arquivos[i];
    if (!a.storage_path) return { error: `Arquivo #${i + 1} sem storage_path.` };
    if (a.size <= 0) return { error: `Arquivo #${i + 1} vazio.` };
    if (a.mime_type !== 'application/pdf') return { error: `"${a.filename}" não é PDF.` };
    if (a.size > 100 * 1024 * 1024) return { error: `"${a.filename}" passa de 100 MB.` };
    if (!TIPOS_VALIDOS.has(a.tipo)) {
      return { error: `Tipo "${a.tipo}" inválido pra "${a.filename}".` };
    }
    if (!/^[a-f0-9]{64}$/.test(a.hash_sha256)) {
      return { error: `Hash inválido pra "${a.filename}".` };
    }
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Não autenticado.' };

  const admin = createAdminClient();

  // 1) Cria a licitação em rascunho
  const { data: licitacao, error: licErr } = await admin
    .from('licitacoes')
    .insert({ titulo, criado_por: user.id, status: 'rascunho' })
    .select('id')
    .single();
  if (licErr || !licitacao) {
    return { error: `Falha ao criar orçamento: ${licErr?.message ?? 'sem dado'}` };
  }

  // 2) Insere rows em licitacao_arquivos referenciando os paths já uploadados
  const rows = arquivos.map((a) => ({
    licitacao_id: licitacao.id,
    tipo: a.tipo,
    storage_bucket: 'editais',
    storage_path: a.storage_path,
    filename_original: a.filename,
    mime_type: a.mime_type,
    size_bytes: a.size,
    hash_sha256: a.hash_sha256,
    enviado_por: user.id,
  }));
  const { error: arqErr } = await admin.from('licitacao_arquivos').insert(rows);
  if (arqErr) {
    // Cleanup: apaga arquivos do storage + licitação
    await supabase.storage.from('editais').remove(arquivos.map((a) => a.storage_path));
    await admin.from('licitacoes').delete().eq('id', licitacao.id);
    return { error: `Falha ao registrar arquivos: ${arqErr.message}` };
  }

  // 3) Avança status: rascunho → aguardando_extracao
  await admin
    .from('licitacoes')
    .update({ status: 'aguardando_extracao' })
    .eq('id', licitacao.id);

  // 4) Auto-otimização dos PDFs (não fatal — só reduz tamanho/custo antes da
  // extração; se falhar, o usuário segue normalmente e pode otimizar depois
  // manualmente na tela da licitação).
  try {
    await otimizarPdfs(licitacao.id);
  } catch (otimErr) {
    console.error('[createLicitacao] otimizarPdfs falhou (não fatal)', otimErr);
  }

  redirect(`/licitacoes/${licitacao.id}`);
}
