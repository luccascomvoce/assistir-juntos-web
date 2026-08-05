<![CDATA[# Deploy Script for Assistir Juntos
# Pipeline completo: rebuild container -> extract tunnel URL -> commit & push to GitHub
param(
    [switch]$SkipGit = $false
)

$ErrorActionPreference = "Stop"
$startTime = Get-Date

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  DEPLOY - ASSISTIR JUNTOS" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Etapa 1: Parar containers antigos
Write-Host "[1/5] Parando containers antigos..." -ForegroundColor Yellow
docker-compose down --remove-orphans 2>$null
Write-Host "       Containers parados." -ForegroundColor Green

# Etapa 2: Build e start
Write-Host "[2/5] Construindo imagem e iniciando containers..." -ForegroundColor Yellow
docker-compose up -d --build
Write-Host "       Build concluido, containers iniciados." -ForegroundColor Green

# Etapa 3: Aguardar tunel Cloudflare
Write-Host "[3/5] Aguardando tunel Cloudflare (12s)..." -ForegroundColor Yellow
Start-Sleep -Seconds 12

# Extrair URL do tunel (tenta multiplas vezes)
$tunnelUrl = $null
$maxRetries = 5
for ($i = 0; $i -lt $maxRetries; $i++) {
    $logs = docker logs assistir-juntos-tunnel 2>&1 | Out-String
    $tunnelUrl = [regex]::Match($logs, 'https://[a-z0-9.-]+\.trycloudflare\.com').Value
    if ($tunnelUrl) { break }
    Write-Host "       Tentativa $($i+1)/$maxRetries - aguardando tunel..." -ForegroundColor Gray
    Start-Sleep -Seconds 5
}

if (-not $tunnelUrl) {
    Write-Host "ERRO: URL do tunel nao encontrada apos $maxRetries tentativas." -ForegroundColor Red
    Write-Host "   Verifique: docker logs assistir-juntos-tunnel" -ForegroundColor Gray
    exit 1
}

Write-Host "       Tunel detectado: $tunnelUrl" -ForegroundColor Green

# Etapa 4: Salvar URL e mostrar tokens
Write-Host "[4/5] Atualizando tunnel-url.json..." -ForegroundColor Yellow
$config = @{ url = $tunnelUrl } | ConvertTo-Json -Compress
Set-Content -Path "docs\tunnel-url.json" -Value $config
Write-Host "       Salvo em docs/tunnel-url.json" -ForegroundColor Green

# Mostrar tokens
Write-Host ""
Write-Host "       Tokens de acesso:" -ForegroundColor Cyan
if (Test-Path "data\tokens.json") {
    $tokens = Get-Content "data\tokens.json" | ConvertFrom-Json
    $tokens.PSObject.Properties | ForEach-Object {
        Write-Host "         $($_.Name) - token: $($_.Value)" -ForegroundColor White
    }
} else {
    Write-Host "         Nenhum token configurado." -ForegroundColor Gray
}

# Etapa 5: Git commit e push
if ($SkipGit) {
    Write-Host "[5/5] Git SKIP (SkipGit ativado)" -ForegroundColor DarkYellow
} else {
    Write-Host "[5/5] Commit e push para GitHub..." -ForegroundColor Yellow
    
    $hasChanges = git status --porcelain 2>&1
    if ($hasChanges) {
        git add docs/ 2>&1 | Out-Null
        $dateStr = Get-Date -Format "yyyy-MM-dd HH:mm"
        $commitMsg = "deploy: atualiza tunnel URL ($dateStr)"
        git commit -m $commitMsg 2>&1 | Out-Null
        Write-Host "       Commit: $commitMsg" -ForegroundColor Gray
        
        git push origin main 2>&1 | Out-Null
        Write-Host "       Push para origin/main concluido." -ForegroundColor Green
        Write-Host "       GitHub Pages fara o deploy automaticamente em ~1-2 min." -ForegroundColor Gray
    } else {
        Write-Host "       Nenhuma alteracao para commitar (URL ja esta atualizada)." -ForegroundColor Gray
    }
}

# Resumo final
$elapsed = [math]::Round(((Get-Date) - $startTime).TotalSeconds, 1)
Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  DEPLOY CONCLUIDO (" + $elapsed + "s)" -ForegroundColor Green
Write-Host "  $tunnelUrl" -ForegroundColor White
Write-Host "  https://luccascomvoce.github.io/assistir-juntos-web" -ForegroundColor White
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
]]>