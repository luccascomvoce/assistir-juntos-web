# ── Deploy Script for Assistir Juntos ──
Write-Host "🚀 Iniciando deploy..." -ForegroundColor Cyan

# Stop and remove old containers
Write-Host "Parando containers antigos..." -ForegroundColor Yellow
docker-compose down --remove-orphans 2>$null

# Build and start
Write-Host "Construindo e iniciando containers..." -ForegroundColor Yellow
docker-compose up -d --build

# Wait for services
Write-Host "Aguardando serviços iniciarem..." -ForegroundColor Yellow
Start-Sleep -Seconds 12

# Extract tunnel URL
Write-Host "Extraindo URL do túnel..." -ForegroundColor Yellow
$logs = docker logs assistir-juntos-tunnel 2>&1 | Out-String
$url = [regex]::Match($logs, 'https://[a-z0-9.-]+\.trycloudflare\.com').Value

if ($url) {
    Write-Host ""
    Write-Host "══════════════════════════════════════" -ForegroundColor Green
    Write-Host "  ✅ Deploy concluído!" -ForegroundColor Green
    Write-Host "  Link: $url" -ForegroundColor White
    Write-Host "══════════════════════════════════════" -ForegroundColor Green
    Write-Host ""

    # Save to frontend config
    $config = @{ url = $url } | ConvertTo-Json -Compress
    Set-Content -Path "frontend\tunnel-url.json" -Value $config
    Write-Host "tunnel-url.json atualizado" -ForegroundColor Gray

    # Show tokens
    Write-Host ""
    Write-Host "Tokens de acesso:" -ForegroundColor Cyan
    if (Test-Path "data\tokens.json") {
        $tokens = Get-Content "data\tokens.json" | ConvertFrom-Json
        $tokens.PSObject.Properties | ForEach-Object {
            Write-Host "  $($_.Name) → token: $($_.Value)" -ForegroundColor White
        }
    }
} else {
    Write-Host "⚠️  Tunnel URL não encontrada. Verifique os logs:" -ForegroundColor Red
    Write-Host "docker logs assistir-juntos-tunnel" -ForegroundColor Gray
}