param(
    [string] $BundleRoot,
    [string] $FilePath,
    [switch] $TopLevelOnly,
    [switch] $KeepCli
)

$ErrorActionPreference = 'Stop'

if (-not $env:EVSIGN_LICENSE_KEY) {
    throw 'EVSIGN_LICENSE_KEY is required to Authenticode-sign Windows binaries.'
}

$hasBundleRoot = -not [string]::IsNullOrWhiteSpace($BundleRoot)
$hasFilePath = -not [string]::IsNullOrWhiteSpace($FilePath)
if ($hasBundleRoot -eq $hasFilePath) {
    throw 'Specify exactly one of -BundleRoot or -FilePath.'
}

# Ensure TLS 1.2 is enabled when invoked under Windows PowerShell 5.1.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

# GitHub-hosted runners get HTTP 444 from mc.evsign.cn. Use the official CLI
# mirrored as a repo release asset and verify the pin before signing.
$cliUrl = 'https://github.com/DimoADE/Dimo/releases/download/evsign-cli-1.0.1/evsign-client-cli-win_v1.0.1.exe'
$cliSha256 = 'b1b2168a1d0ea757f26db18ac2e2b14e06fb74021f0d67add5e6be1a47dffd97'
$cliDir = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }
$cliPath = Join-Path $cliDir 'evsign-client.exe'

$needDownload = $true
if (Test-Path -LiteralPath $cliPath -PathType Leaf) {
    $cachedSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $cliPath).Hash.ToLowerInvariant()
    if ($cachedSha256 -eq $cliSha256) {
        $needDownload = $false
    } else {
        Remove-Item -LiteralPath $cliPath -Force -ErrorAction SilentlyContinue
    }
}

if ($needDownload) {
    $tmpCliPath = "$cliPath.tmp.$PID"
    try {
        Invoke-WebRequest `
            -Uri $cliUrl `
            -OutFile $tmpCliPath `
            -UseBasicParsing
        Unblock-File -LiteralPath $tmpCliPath

        $actualSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $tmpCliPath).Hash.ToLowerInvariant()
        if ($actualSha256 -ne $cliSha256) {
            throw "EVSign CLI checksum mismatch: expected $cliSha256, got $actualSha256"
        }

        Move-Item -LiteralPath $tmpCliPath -Destination $cliPath -Force
    } catch {
        Remove-Item -LiteralPath $tmpCliPath -Force -ErrorAction SilentlyContinue
        throw
    }
}

$artifacts = if ($hasFilePath) {
    if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) {
        throw "Windows binary does not exist: $FilePath"
    }
    @(Get-Item -LiteralPath $FilePath)
} else {
    if (-not (Test-Path -LiteralPath $BundleRoot)) {
        throw "Windows bundle directory does not exist: $BundleRoot"
    }
    @(if ($TopLevelOnly) {
        Get-ChildItem -LiteralPath $BundleRoot -File |
            Where-Object { $_.Extension -in '.exe', '.msi' }
    } else {
        Get-ChildItem -LiteralPath $BundleRoot -Recurse -File |
            Where-Object { $_.Extension -in '.exe', '.msi' }
    })
}

if ($artifacts.Count -eq 0) {
    throw "No Windows binaries were found to sign."
}

try {
    foreach ($artifact in $artifacts) {
        $signArgs = @(
            $artifact.FullName,
            '-key', $env:EVSIGN_LICENSE_KEY,
            '-sha256',
            '-t', 'digicert',
            '-cdn'
        )
        if ($env:EVSIGN_SIGN_PASSWORD) {
            $signArgs += @('-pwd', $env:EVSIGN_SIGN_PASSWORD)
        }

        $signed = $false
        for ($attempt = 1; $attempt -le 3; $attempt++) {
            & $cliPath @signArgs
            if ($LASTEXITCODE -eq 0) {
                $signature = Get-AuthenticodeSignature -LiteralPath $artifact.FullName
                if ($signature.Status -eq 'Valid') {
                    $signed = $true
                    break
                }
                Write-Host "EVSign attempt $attempt exited 0 for $($artifact.Name), but Authenticode status is $($signature.Status)"
            } else {
                Write-Host "EVSign attempt $attempt failed for $($artifact.Name) with exit code $LASTEXITCODE"
            }
            if ($attempt -lt 3) {
                Start-Sleep -Seconds (10 * $attempt)
            }
        }
        if (-not $signed) {
            throw "EVSign failed for $($artifact.Name) after 3 attempts"
        }

        if (Test-Path -LiteralPath "$($artifact.FullName).sig") {
            if (-not $env:TAURI_SIGNING_PRIVATE_KEY) {
                throw 'TAURI_SIGNING_PRIVATE_KEY is required to refresh updater signatures after Authenticode signing.'
            }

            & pnpm dlx @tauri-apps/cli@2.10.0 signer sign $artifact.FullName
            if ($LASTEXITCODE -ne 0) {
                throw "Failed to refresh the updater signature for $($artifact.Name)"
            }
        }
    }
} finally {
    if (-not $KeepCli) {
        Remove-Item -LiteralPath $cliPath -Force -ErrorAction SilentlyContinue
    }
}
