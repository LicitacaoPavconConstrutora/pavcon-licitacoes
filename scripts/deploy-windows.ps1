<#
.SYNOPSIS
    Sobe as Edge Functions do OrcaPav para o projeto Supabase correto.

.DESCRIPTION
    Script de deploy para Windows. Pensado para ser rodado no PowerShell
    como Administrador, sem que voce precise saber nada de linha de comando.

    O PROJECT REF esta travado no codigo (cwgjjjlyccgivscngzgz). O script
    recusa qualquer outro projeto. Isso e proposital: a mesma conta Supabase
    hospeda outros projetos e nenhum deles pode ser tocado por este script.

    Nota sobre PowerShell 5.1: programas externos (git, npm, supabase)
    escrevem avisos no stderr o tempo todo. Com ErrorActionPreference='Stop'
    e saida redirecionada, o PowerShell transforma esses avisos em erro
    fatal e mata o script no meio. Por isso aqui a preferencia fica em
    'Continue' e cada chamada e conferida pelo codigo de saida, que e o
    unico sinal confiavel de sucesso ou falha.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\deploy-windows.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\deploy-windows.ps1 -Funcoes orcafascio-cadastrar-edital,orcafascio-cadastrar-orcamento
#>

[CmdletBinding()]
param(
    # Funcoes a subir. Por padrao sobe so a de orcamento.
    [string[]] $Funcoes = @('orcafascio-cadastrar-orcamento'),

    # Pasta onde o repositorio fica (ou sera clonado).
    [string] $Pasta = (Join-Path $env:USERPROFILE 'pavcon-licitacoes'),

    # Branch a usar. 'main' tem o codigo ja revisado e mergeado.
    [string] $Branch = 'main',

    # Pula o git pull e sobe o que ja estiver na pasta.
    [switch] $SemAtualizar
)

# Ver a nota sobre PowerShell 5.1 em .DESCRIPTION. Nao troque para 'Stop'.
$ErrorActionPreference = 'Continue'

# --- TRAVA DE SEGURANCA ---------------------------------------------------
# Nao transforme isto em parametro. Ver o bloco .DESCRIPTION acima.
$PROJECT_REF = 'cwgjjjlyccgivscngzgz'
$REPO_URL    = 'https://github.com/LicitacaoPavconConstrutora/pavcon-licitacoes.git'
$CLI         = 'supabase@2.98.2'
# --------------------------------------------------------------------------

function Escreve($texto, $cor = 'White') { Write-Host $texto -ForegroundColor $cor }
function Passo($n, $texto) { Write-Host ''; Escreve ">> Passo $n - $texto" 'Cyan' }
function Ok($texto)    { Escreve "   OK: $texto" 'Green' }
function Aviso($texto) { Escreve "   ! $texto" 'Yellow' }

function Morre($mensagem) {
    Write-Host ''
    Escreve '=========================================================' 'Red'
    Escreve '  PAROU' 'Red'
    Escreve '=========================================================' 'Red'
    Escreve $mensagem 'Red'
    exit 1
}

# ATENCAO: nao embrulhe em funcao as chamadas que mostram saida na tela.
# Em PowerShell, 'return $LASTEXITCODE' devolve TUDO que a funcao escreveu
# mais o codigo, ou seja, um array; e array comparado com 0 da verdadeiro.
# Por isso git/npx sao chamados direto e conferidos por $LASTEXITCODE.

# Roda um programa externo engolindo a saida. Devolve codigo e texto.
function RodarQuieto {
    param([Parameter(Mandatory)][string] $Exe, [string[]] $Argumentos = @())
    $texto = (& $Exe @Argumentos 2>&1 | Out-String)
    return [pscustomobject]@{ Codigo = $LASTEXITCODE; Saida = $texto }
}

function Existe($comando) {
    $null -ne (Get-Command $comando -ErrorAction SilentlyContinue)
}

function GarantePrograma($comando, $wingetId, $nomeAmigavel) {
    if (Existe $comando) { Ok "$nomeAmigavel ja instalado."; return }
    if (-not (Existe 'winget')) {
        Morre "$nomeAmigavel nao esta instalado e o winget nao existe nesta maquina. Instale $nomeAmigavel manualmente e rode o script de novo."
    }
    Aviso "$nomeAmigavel nao encontrado. Instalando via winget..."
    winget install --id $wingetId --silent --accept-package-agreements --accept-source-agreements
    # O PATH so e relido pelo processo atual depois disto:
    $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' +
                [Environment]::GetEnvironmentVariable('Path','User')
    if (-not (Existe $comando)) {
        Morre "$nomeAmigavel foi instalado mas ainda nao aparece no PATH. Feche e reabra o PowerShell como Administrador e rode o script de novo."
    }
    Ok "$nomeAmigavel instalado."
}

Escreve ''
Escreve '=========================================================' 'Magenta'
Escreve '  OrcaPav - deploy de Edge Functions' 'Magenta'
Escreve "  Projeto Supabase: $PROJECT_REF" 'Magenta'
Escreve '=========================================================' 'Magenta'

# -------------------------------------------------------------------------
Passo 1 'Conferindo Git e Node'
GarantePrograma 'git'  'Git.Git'       'Git'
GarantePrograma 'node' 'OpenJS.NodeJS' 'Node.js'

$versaoNode = (node --version) -replace '^v',''
if ([int]($versaoNode.Split('.')[0]) -lt 20) {
    Morre "Node $versaoNode e antigo demais. O projeto precisa da versao 20 ou maior."
}
Ok "Node $versaoNode."

# -------------------------------------------------------------------------
Passo 2 'Baixando o codigo'
if (Test-Path (Join-Path $Pasta '.git')) {
    Set-Location $Pasta
    if ($SemAtualizar) {
        Aviso 'Pulando a atualizacao (-SemAtualizar).'
    } else {
        $sujo = (RodarQuieto 'git' @('status','--porcelain')).Saida.Trim()
        if ($sujo) {
            Morre "A pasta $Pasta tem alteracoes nao salvas:`n$sujo`n`nResolva no Git antes, ou rode com -SemAtualizar para subir exatamente o que esta ai."
        }
        git fetch origin $Branch
        if ($LASTEXITCODE -ne 0) { Morre 'git fetch falhou. Confira sua conexao.' }
        git checkout $Branch
        if ($LASTEXITCODE -ne 0) { Morre "git checkout $Branch falhou." }
        git reset --hard "origin/$Branch"
        if ($LASTEXITCODE -ne 0) { Morre 'git reset falhou.' }
    }
} else {
    Escreve "   Clonando em $Pasta ..."
    git clone --branch $Branch $REPO_URL $Pasta
    if ($LASTEXITCODE -ne 0) { Morre 'git clone falhou.' }
    Set-Location $Pasta
}
$commit = (RodarQuieto 'git' @('rev-parse','--short','HEAD')).Saida.Trim()
Ok "Codigo em $Pasta ($commit)."

# -------------------------------------------------------------------------
Passo 3 'Preparando a CLI do Supabase'
# Usamos npx com a versao fixa. Assim nao dependemos do postinstall do npm,
# que as versoes novas do npm bloqueiam por padrao (o aviso 'allow-scripts').
$v = RodarQuieto 'npx' @('--yes',$CLI,'--version')
if ($v.Codigo -ne 0) {
    Morre "Nao consegui preparar a CLI do Supabase:`n$($v.Saida)"
}
# So o numero: no PowerShell 5.1 a saida capturada traz junto o aviso de
# "nova versao disponivel" da CLI, formatado como se fosse erro.
$versaoCli = [regex]::Match($v.Saida, '\d+\.\d+\.\d+').Value
Ok "CLI do Supabase $versaoCli."

# -------------------------------------------------------------------------
Passo 4 'Entrando na sua conta Supabase'
$jaLogado = $false
if ($env:SUPABASE_ACCESS_TOKEN) {
    Ok 'Usando o token da variavel SUPABASE_ACCESS_TOKEN.'
    $jaLogado = $true
} else {
    # 'Access token not provided' aqui NAO e falha: e so a resposta de quem
    # ainda nao fez login. Por isso conferimos o codigo de saida e seguimos.
    $teste = RodarQuieto 'npx' @('--yes',$CLI,'projects','list')
    if ($teste.Codigo -eq 0) { $jaLogado = $true }
}

if (-not $jaLogado) {
    Aviso 'Voce ainda nao esta logado. Vai abrir o navegador.'
    Aviso 'ENTRE COM A CONTA DONA DO PROJETO DA LICITACAO, nao a de outro projeto.'
    npx --yes $CLI login
    if ($LASTEXITCODE -ne 0) {
        Morre 'O login no Supabase nao foi concluido. Rode o script de novo.'
    }
}
Ok 'Autenticado.'

# -------------------------------------------------------------------------
Passo 5 'Conferindo que a conta enxerga o projeto certo'
$lista = RodarQuieto 'npx' @('--yes',$CLI,'projects','list')
if ($lista.Codigo -ne 0) {
    Morre "Nao consegui listar os projetos da conta:`n$($lista.Saida)"
}
if ($lista.Saida -notmatch [regex]::Escape($PROJECT_REF)) {
    Escreve ''
    Escreve $lista.Saida 'DarkGray'
    Morre @"
A conta Supabase em que voce entrou NAO tem o projeto $PROJECT_REF.
Voce entrou na conta de outro projeto.

Rode:
    npx $CLI logout

e depois este script de novo, escolhendo a conta certa.
Nada foi alterado.
"@
}
Ok "Projeto $PROJECT_REF visivel nesta conta."

# -------------------------------------------------------------------------
Passo 6 "Subindo $($Funcoes.Count) funcao(oes)"
$falhas = @()
foreach ($fn in $Funcoes) {
    $caminho = [IO.Path]::Combine($Pasta, 'supabase', 'functions', $fn, 'index.ts')
    if (-not (Test-Path $caminho)) {
        $falhas += "$fn (pasta nao existe no repositorio)"
        Aviso "$fn - pulada, nao existe em supabase/functions."
        continue
    }
    Escreve "   Subindo $fn ..." 'White'
    npx --yes $CLI functions deploy $fn --project-ref $PROJECT_REF
    if ($LASTEXITCODE -ne 0) {
        $falhas += $fn
        Aviso "$fn - FALHOU."
    } else {
        Ok "$fn no ar."
    }
}

Write-Host ''
if ($falhas.Count -gt 0) {
    Escreve '=========================================================' 'Red'
    Escreve '  Terminou COM FALHAS:' 'Red'
    $falhas | ForEach-Object { Escreve "   - $_" 'Red' }
    Escreve '=========================================================' 'Red'
    exit 1
}

Escreve '=========================================================' 'Green'
Escreve '  Tudo no ar.' 'Green'
Escreve '=========================================================' 'Green'
