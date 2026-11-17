$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$staging = Join-Path $env:TEMP "eventwise-budget-package"
$output = Join-Path $root "eventwise-budget.zip"

try {
    # Create a clean temporary staging directory
    if (Test-Path $staging) {
        Remove-Item $staging -Recurse -Force
    }

    New-Item -ItemType Directory -Path $staging | Out-Null

    # Copy dependency manifests
    Copy-Item (Join-Path $root "package.json") $staging
    Copy-Item (Join-Path $root "package-lock.json") $staging

    # Copy compiled backend modules
    foreach ($folder in @("event-service", "shared", "expense-service", "guest-service", "certs")) {
        Copy-Item `
            (Join-Path $root "dist\$folder") `
            (Join-Path $staging $folder) `
            -Recurse
    }

    # Copy Cognito public signing keys into the Lambda package.
    $jwksSource = Join-Path $PSScriptRoot "..\certs\cognito-jwks.json"
    $jwksDestination = Join-Path $staging "certs\cognito-jwks.json"

    if (-not (Test-Path $jwksSource)) {
        throw "Missing Cognito JWKS file: $jwksSource"
    }

    Copy-Item -Path $jwksSource -Destination $jwksDestination -Force

    # Install production dependencies
    Push-Location $staging
    try {
        npm ci --omit=dev --no-audit --no-fund

        if ($LASTEXITCODE -ne 0) {
            throw "npm ci failed"
        }

        # Create deployment ZIP
        Compress-Archive -Path * -DestinationPath $output -Force
    }
    finally {
        Pop-Location
    }

    Write-Host "Created deployment package: $output"
}
finally {
    if (Test-Path $staging) {
        Remove-Item $staging -Recurse -Force
    }
}
