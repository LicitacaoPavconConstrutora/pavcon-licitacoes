'use client';

import { useState, useTransition } from 'react';
import {
  approveExtraction,
  saveExtractionEdits,
  type ExtractedItem,
} from './actions';
import { formatBRL } from '@/lib/utils';

type ExtractedJson = {
  cabecalho: Record<string, unknown>;
  itens: ExtractedItem[];
};

interface Props {
  licitacaoId: string;
  extracaoId: string;
  jsonInicial: ExtractedJson;
  jaRevisada: boolean;
  /** Chamado logo após "Aprovar e seguir" transicionar o status com sucesso —
   * dispara automaticamente o cadastro completo no Orçafascio (Passo 1+2),
   * já que o clique em "Aprovar" já é o momento em que o orçamentista
   * confirma que revisou os dados; o cadastro em si é só a etapa mecânica
   * seguinte. */
  onApproved?: () => void;
}

export function ExtractionEditor({
  licitacaoId,
  extracaoId,
  jsonInicial,
  jaRevisada,
  onApproved,
}: Props) {
  const [json, setJson] = useState<ExtractedJson>(() => structuredClone(jsonInicial));
  const [editMode, setEditMode] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionInfo, setActionInfo] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const cabecalhoFields: Array<{ key: keyof typeof json.cabecalho; label: string; type?: 'number' | 'boolean' | 'text' }> = [
    { key: 'orgao', label: 'Órgão' },
    { key: 'objeto', label: 'Objeto' },
    { key: 'municipio', label: 'Município' },
    { key: 'uf', label: 'UF' },
    { key: 'numero_edital', label: 'Número do edital' },
    { key: 'data_base_descricao', label: 'Data base' },
    { key: 'leis_sociais_percentual', label: 'Leis sociais (%)', type: 'number' },
    { key: 'bdi_percentual', label: 'BDI (%)', type: 'number' },
    { key: 'com_desoneracao', label: 'Com desoneração?', type: 'boolean' },
  ];

  function updateCabecalho(key: string, value: unknown) {
    setJson((j) => ({ ...j, cabecalho: { ...j.cabecalho, [key]: value } }));
  }

  function updateItem(idx: number, patch: Partial<ExtractedItem>) {
    setJson((j) => {
      const itens = [...j.itens];
      itens[idx] = { ...itens[idx], ...patch };
      return { ...j, itens };
    });
  }

  function handleSave() {
    setActionError(null);
    setActionInfo(null);
    startTransition(async () => {
      const r = await saveExtractionEdits(licitacaoId, extracaoId, json);
      if (r?.error) setActionError(r.error);
      else {
        setActionInfo('Revisão salva.');
        setEditMode(false);
      }
    });
  }

  function handleApprove() {
    setActionError(null);
    setActionInfo(null);
    startTransition(async () => {
      // Salva a revisão se ainda não foi salva
      if (editMode || !jaRevisada) {
        const saveResult = await saveExtractionEdits(licitacaoId, extracaoId, json);
        if (saveResult?.error) {
          setActionError(saveResult.error);
          return;
        }
      }
      const r = await approveExtraction(licitacaoId);
      if (r?.error) {
        setActionError(r.error);
        return;
      }
      onApproved?.();
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-zinc-700">
          Extração concluída. Revise antes de aprovar.
        </p>
        <div className="flex items-center gap-2">
          {!editMode ? (
            <button
              onClick={() => setEditMode(true)}
              className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
            >
              Editar
            </button>
          ) : (
            <>
              <button
                onClick={() => {
                  setJson(structuredClone(jsonInicial));
                  setEditMode(false);
                }}
                className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
              >
                Cancelar
              </button>
              <button
                onClick={handleSave}
                disabled={isPending}
                className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {isPending ? 'Salvando…' : 'Salvar revisão'}
              </button>
            </>
          )}
          <button
            onClick={handleApprove}
            disabled={isPending}
            title="Aprova a extração e já dispara o cadastro completo no Orçafascio (Passo 1+2), sem precisar clicar de novo"
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {isPending ? 'Aprovando e cadastrando…' : 'Aprovar e cadastrar no Orçafascio'}
          </button>
        </div>
      </div>

      {actionError && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-800">{actionError}</div>
      )}
      {actionInfo && (
        <div className="rounded-md bg-emerald-50 p-3 text-sm text-emerald-800">{actionInfo}</div>
      )}

      <details open className="rounded-md border border-zinc-200 bg-zinc-50 p-4">
        <summary className="cursor-pointer text-sm font-medium text-zinc-800">
          Cabeçalho
        </summary>
        <dl className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {cabecalhoFields.map((f) => (
            <div key={f.key as string}>
              <dt className="text-xs font-medium text-zinc-500">{f.label}</dt>
              <dd className="mt-0.5">
                {editMode
                  ? (
                    f.type === 'boolean' ? (
                      <select
                        className="block w-full rounded-md border border-zinc-300 px-2 py-1 text-sm"
                        value={String(json.cabecalho[f.key] ?? '')}
                        onChange={(e) => {
                          const v = e.target.value;
                          updateCabecalho(
                            f.key as string,
                            v === 'true' ? true : v === 'false' ? false : null,
                          );
                        }}
                      >
                        <option value="">—</option>
                        <option value="true">Sim</option>
                        <option value="false">Não</option>
                      </select>
                    ) : (
                      <input
                        type={f.type === 'number' ? 'number' : 'text'}
                        step="any"
                        className="block w-full rounded-md border border-zinc-300 px-2 py-1 text-sm"
                        value={String(json.cabecalho[f.key] ?? '')}
                        onChange={(e) => {
                          const raw = e.target.value;
                          updateCabecalho(
                            f.key as string,
                            f.type === 'number'
                              ? raw === '' ? null : Number(raw)
                              : raw === '' ? null : raw,
                          );
                        }}
                      />
                    )
                  )
                  : (
                    <span className="text-sm text-zinc-800">
                      {formatCabecalhoValue(json.cabecalho[f.key])}
                    </span>
                  )}
              </dd>
            </div>
          ))}
        </dl>
      </details>

      <div className="rounded-md border border-zinc-200">
        <div className="flex items-center justify-between border-b border-zinc-200 bg-zinc-50 px-4 py-2 text-xs">
          <span className="font-medium text-zinc-700">
            Itens ({json.itens.length})
          </span>
          <span className="text-zinc-500">
            {json.itens.filter((i) => i.tipo === 'servico').length} serviços ·{' '}
            {json.itens.filter((i) => i.fonte === 'PROPRIA').length} próprias
          </span>
        </div>
        <div className="max-h-[600px] overflow-auto">
          <table className="min-w-full text-xs">
            <thead className="sticky top-0 bg-zinc-100 text-zinc-600">
              <tr>
                <Th>Item</Th>
                <Th>Descrição</Th>
                <Th>Cód.</Th>
                <Th>Fonte</Th>
                <Th>Un.</Th>
                <Th align="right">Qtd</Th>
                <Th align="right">Unitário s/ BDI</Th>
                <Th align="right">Total</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {json.itens.map((item, idx) => (
                <tr
                  key={`${item.item_codigo}-${idx}`}
                  className={item.tipo === 'grupo' ? 'bg-zinc-50 font-medium' : ''}
                >
                  <td className="px-2 py-1 align-top text-zinc-700">{item.item_codigo}</td>
                  <td className="px-2 py-1 align-top text-zinc-800">
                    {editMode ? (
                      <input
                        type="text"
                        className="w-full rounded border border-zinc-200 px-1 py-0.5"
                        value={item.descricao}
                        onChange={(e) => updateItem(idx, { descricao: e.target.value })}
                      />
                    ) : (
                      <span className="block max-w-md truncate" title={item.descricao}>
                        {item.descricao}
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-1 align-top text-zinc-600">{item.codigo ?? '—'}</td>
                  <td className="px-2 py-1 align-top">
                    {item.fonte && (
                      <span className="inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium text-zinc-700">
                        {item.fonte}
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-1 align-top text-zinc-600">{item.unidade ?? '—'}</td>
                  <td className="px-2 py-1 text-right align-top tabular-nums">
                    {editMode && item.tipo === 'servico' ? (
                      <input
                        type="number"
                        step="any"
                        className="w-20 rounded border border-zinc-200 px-1 py-0.5 text-right"
                        value={item.quantidade ?? ''}
                        onChange={(e) =>
                          updateItem(idx, { quantidade: e.target.value === '' ? null : Number(e.target.value) })
                        }
                      />
                    ) : (
                      item.quantidade ?? '—'
                    )}
                  </td>
                  <td className="px-2 py-1 text-right align-top tabular-nums">
                    {editMode && item.tipo === 'servico' ? (
                      <input
                        type="number"
                        step="any"
                        className="w-24 rounded border border-zinc-200 px-1 py-0.5 text-right"
                        value={item.preco_unitario_sem_bdi ?? ''}
                        onChange={(e) =>
                          updateItem(idx, {
                            preco_unitario_sem_bdi:
                              e.target.value === '' ? null : Number(e.target.value),
                          })
                        }
                      />
                    ) : (
                      formatBRL(item.preco_unitario_sem_bdi)
                    )}
                  </td>
                  <td className="px-2 py-1 text-right align-top tabular-nums text-zinc-700">
                    {formatBRL(item.preco_total)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Th({
  children,
  align = 'left',
}: {
  children: React.ReactNode;
  align?: 'left' | 'right';
}) {
  return (
    <th
      className={`px-2 py-1.5 text-${align} text-[10px] font-semibold uppercase tracking-wide`}
    >
      {children}
    </th>
  );
}

function formatCabecalhoValue(v: unknown): string {
  if (v == null || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'Sim' : 'Não';
  return String(v);
}
