$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot

if (-not (Test-Path -LiteralPath '.env')) {
    throw '未找到 .env。请先复制 .env.example，并填写本机配置。'
}

& pnpm dev
exit $LASTEXITCODE
