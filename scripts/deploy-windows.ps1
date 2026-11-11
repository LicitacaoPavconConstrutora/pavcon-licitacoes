<#
.SYNOPSIS
    Sobe as Edge Functions do OrcaPav para o projeto Supabase correto.

.DESCRIPTION
    Script de deploy para Windows. Pensado para ser rodado no PowerShell
    como Administrador, sem que voce precise saber nada de linha de comando.

    O PROJECT REF esta travado no codigo (cwgjjjlyccgivscngzgz). O script
    recusa qualquer outro projeto. Isso e proposital: a mesma conta Supabase
    hospeda outros projetos e nenhum deles pode ser tocado por este script.

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

$ErrorActionPreference = 'Stop'

# --- TRAVA DE SEGURANCA ---------------------------------------------------
# Nao transforme isto em parametro. Ver o bloco .DESCRIPTION acima.
$PROJECT_REF = 'cwgjjjlyccgivscngzgz'
$REPO_URL    = 'https://github.com/LicitacaoPavconConstrutora/pavcon-licitacoes.git'
# --------------------------------------------------------------------------

function Escreve($texto, $cor = 'White') { Write-Host $texto -ForegroundColor $cor }
function Passo($n, $texto) { Write-Host ''; Escreve ">> Passo $n - $texto" 'Cyan' }
function Ok($texto)    { Escreve "   OK: $texto" 'Green' }
function Aviso($texto) { Escreve "   ! $texto" 'Yellow' }

function Existe($comando) {
    $null -ne (Get-Command $comando -ErrorAction SilentlyContinue)
}

function GarantePrograma($comando, $wingetId, $nomeAmigavel) {
    if (Existe $comando) { Ok "$nomeAmigavel ja instalado."; return }
    if (-not (Existe 'winget')) {
        throw "$nomeAmigavel nao esta instalado e o winget nao existe nesta maquina. Instale $nomeAmigavel manualmente e rode o script de novo."
    }
    Aviso "$nomeAmigavel nao encontrado. Instalando via winget..."
    winget install --id $wingetId --silent --accept-package-agreements --accept-source-agreements
    # O PATH so e relido pelo processo atual depois disto:
    $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' +
                [Environment]::GetEnvironmentVariable('Path','User')
    if (-not (Existe $comando)) {
        throw "$nomeAmigavel foi instalado mas ainda nao aparece no PATH. Feche e reabra o PowerShell como Administrador e rode o script de novo."
    }
    Ok "$nomeAmigavel instalado."
}

Escreve ''
Escreve '=========================================================' 'Magenta'
Escreve '  OrcaPav - deploy de Edge Functions' 'Magenta'
Escreve "  Projeto Supabase: $PROJECT_REF" 'Magenta'
Escreve '=========================================================' 'Magenta'

Passo 1 'Conferindo Git e Node'
GarantePrograma 'git'  'Git.Git'       'Git'
GarantePrograma 'node' 'OpenJS.NodeJS' 'Node.js'

$versaoNode = (node --version) -replace '^v',''
if ([int]($versaoNode.Split('.')[0]) -lt 20) {
    throw "Node $versaoNode e antigo demais. O projeto precisa da versao 20 ou maior."
}
Ok "Node $versaoNode."

Passo 2 'Baixando o codigo'
if (Test-Path (Join-Path $Pasta '.git')) {
    Set-Location $Pasta
    if ($SemAtualizar) {
        Aviso 'Pulando a atualizacao (-SemAtualizar).'
    } else {
        $sujo = git status --porcelain
        if ($sujo) {
            throw "A pasta $Pasta tem alteracoes nao salvas. Resolva no Git antes, ou rode com -SemAtualizar para subir exatamente o que esta ai."
        }
        git fetch origin $Branch
        git checkout $Branch
        git reset --hard "origin/$Branch"
    }
} else {
    Escreve "   Clonando em $Pasta ..."
    git clone --branch $Branch $REPO_URL $Pasta
    Set-Location $Pasta
}
Ok "Codigo em $Pasta ($(git rev-parse --short HEAD))."

Passo 3 'Instalando as dependencias (a CLI do Supabase vem daqui)'
npm install --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw 'npm install falhou.' }
Ok 'Dependencias instaladas.'

Passo 4 'Entrando na sua conta Supabase'
# Se ja houver token salvo, este comando responde sem abrir nada.
npx --yes supabase projects list *> $null
if ($LASTEXITCODE -ne 0) {
    Aviso 'Vai abrir o navegador para voce entrar na conta Supabase.'
    Aviso 'Use a conta que e dona do projeto da LICITACAO, nao a de outro projeto.'
    npx --yes supabase login
    if ($LASTEXITCODE -ne 0) { throw 'Login no Supabase falhou.' }
}
Ok 'Autenticado.'

Passo 5 'Conferindo que a conta enxerga o projeto certo'
$listagem = npx --yes supabase projects list 2>&1 | Out-String
if ($listagem -notmatch [regex]::Escape($PROJECT_REF)) {
    Escreve ''
    Escreve $listagem 'DarkGray'
    throw @"
A conta Supabase em que voce entrou NAO tem o projeto $PROJECT_REF.
Voce entrou na conta de outro projeto. Rode:
    npx supabase logout
e depois este script de novo, escolhendo a conta certa.
Nada foi alterado.
"@
}
Ok "Projeto $PROJECT_REF visivel nesta conta."

Passo 6 "Subindo $($Funcoes.Count) funcao(oes)"
$falhas = @()
foreach ($fn in $Funcoes) {
    $caminho = Join-Path $Pasta "supabase\functions\$fn\index.ts"
    if (-not (Test-Path $caminho)) {
        $falhas += "$fn (pasta nao existe no repositorio)"
        Aviso "$fn - pulada, nao existe em supabase/functions."
        continue
    }
    Escreve "   Subindo $fn ..." 'White'
    npx --yes supabase functions deploy $fn --project-ref $PROJECT_REF
    if ($LASTEXITCODE -ne 0) {
        $falhas += $fn
        Aviso "$fn - FALHOU."
    } else {
        Ok "$fn no ar."
    }
}

Escreve ''
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
