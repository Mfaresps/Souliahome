$ErrorActionPreference = 'Stop'
$filmRoot = $PSScriptRoot
$stageRoot = Join-Path $filmRoot 'source-package'
$filmStage = Join-Path $stageRoot 'premium-v2'
New-Item -ItemType Directory -Force -Path $filmStage | Out-Null
Get-ChildItem -LiteralPath $filmRoot -File | Where-Object {
    $_.Extension -in '.cjs', '.js', '.html', '.json', '.md', '.ps1' -or $_.Name -eq '.gitignore'
} | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $filmStage -Force }
Copy-Item -LiteralPath (Join-Path $filmRoot 'assets') -Destination $filmStage -Recurse -Force
Copy-Item -LiteralPath (Join-Path (Split-Path $filmRoot -Parent) 'package.json') -Destination $stageRoot -Force
Copy-Item -LiteralPath (Join-Path (Split-Path $filmRoot -Parent) 'package-lock.json') -Destination $stageRoot -Force
$reviewStage = Join-Path $filmStage 'review'
New-Item -ItemType Directory -Force -Path $reviewStage | Out-Null
Copy-Item -LiteralPath (Join-Path $filmRoot 'review/encoded-contact-sheet.png') -Destination $reviewStage -Force
$inputs = @(Get-ChildItem -LiteralPath $stageRoot | ForEach-Object FullName)
Compress-Archive -LiteralPath $inputs -DestinationPath (Join-Path $filmRoot 'Soulia-Editable-Source.zip') -Force
Write-Output 'Editable source packaged. Extract into artifacts/product-reel in the existing workspace.'
