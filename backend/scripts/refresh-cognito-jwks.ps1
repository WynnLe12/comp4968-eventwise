$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$destination = Join-Path $root "certs\cognito-jwks.json"

$poolId = Read-Host "Enter COGNITO_USER_POOL_ID"

if ($poolId -notmatch '^us-west-2_[A-Za-z0-9]+$') {
    throw "Invalid Cognito User Pool ID for us-west-2"
}

$url = "https://cognito-idp.us-west-2.amazonaws.com/$poolId/.well-known/jwks.json"

$temp = "$destination.tmp"

try {
    Invoke-WebRequest -Uri $url -OutFile $temp

    $jwks = Get-Content $temp -Raw | ConvertFrom-Json

    if (-not $jwks.keys -or $jwks.keys.Count -lt 1) {
        throw "No signing keys found in JWKS"
    }

    foreach ($key in $jwks.keys) {
        if ($key.kty -ne "RSA" -or
            -not $key.kid -or
            -not $key.n -or
            -not $key.e) {
            throw "Invalid Cognito RSA signing key"
        }
    }

    Move-Item $temp $destination -Force

    Write-Host "Cognito JWKS updated successfully."
    Write-Host "Public signing keys:" $jwks.keys.Count
}
finally {
    if (Test-Path $temp) {
        Remove-Item $temp -Force
    }
}
