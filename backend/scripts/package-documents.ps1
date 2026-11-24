$ErrorActionPreference = "Stop"

$backend = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$staging = Join-Path $env:TEMP "eventwise-documents-package"
$output = Join-Path $backend "eventwise-documents.zip"

Write-Host "Building EventWise Documents Lambda..."

Push-Location $backend

try {
    npm run build

    if ($LASTEXITCODE -ne 0) {
        throw "TypeScript build failed."
    }

    if (Test-Path $staging) {
        Remove-Item $staging -Recurse -Force
    }

    New-Item -ItemType Directory -Path $staging -Force |
        Out-Null

    # Copy compiled backend code and certificates.
    $folders = @(
        "document-service",
        "shared",
        "event-service",
        "expense-service",
        "certs"
    )

    foreach ($folder in $folders) {
        $source = Join-Path $backend "dist\$folder"

        if (Test-Path $source) {
            Copy-Item `
                -Path $source `
                -Destination $staging `
                -Recurse `
                -Force
        }
    }

    # Include Cognito public keys for offline JWT verification.
    $jwksSource = Join-Path $backend "certs\cognito-jwks.json"
    $jwksDestination = Join-Path $staging "certs\cognito-jwks.json"

    if (-not (Test-Path $jwksSource)) {
        throw "Missing Cognito JWKS file."
    }

    Copy-Item $jwksSource $jwksDestination -Force

    # Install production dependencies in the Lambda package.
    Copy-Item `
        (Join-Path $backend "package.json") `
        $staging

    Copy-Item `
        (Join-Path $backend "package-lock.json") `
        $staging

    Push-Location $staging

    try {
        npm ci --omit=dev

        if ($LASTEXITCODE -ne 0) {
            throw "Production dependency installation failed."
        }
    }
    finally {
        Pop-Location
    }

    if (Test-Path $output) {
        Remove-Item $output -Force
    }

    # Build the ZIP with Lambda-compatible forward-slash paths.
    @'
import os
import sys
import zipfile

source_dir = sys.argv[1]
output_file = sys.argv[2]

with zipfile.ZipFile(
    output_file,
    "w",
    compression=zipfile.ZIP_DEFLATED
) as archive:
    for root, dirs, files in os.walk(source_dir):
        dirs.sort()
        for filename in sorted(files):
            full_path = os.path.join(root, filename)
            relative_path = os.path.relpath(
                full_path, source_dir
            ).replace(os.sep, "/")

            archive.write(full_path, relative_path)

with zipfile.ZipFile(output_file) as archive:
    required = [
        "document-service/lambda/documents.js",
        "shared/auth/cognito.js",
        "certs/cognito-jwks.json",
        "certs/rds-ca.pem",
    ]

    for name in required:
        if name not in archive.namelist():
            raise RuntimeError(
                "Missing required file: " + name
            )

    if archive.testzip() is not None:
        raise RuntimeError("ZIP integrity check failed")

print("Documents Lambda package verified.")
'@ | python - $staging $output

    if ($LASTEXITCODE -ne 0) {
        throw "ZIP packaging failed."
    }

    Write-Host "Package created: $output"
}
finally {
    Pop-Location
}
