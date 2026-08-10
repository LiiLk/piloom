$ErrorActionPreference = "Stop"

$unconfiguredBaseUrl = "__PRIME_AGENT_DOWNLOAD_BASE_URL__"
$unconfiguredDefaultChannel = "__PRIME_AGENT_DEFAULT_RELEASE_" + "CHANNEL__"
$baseUrl = if ($env:PRIME_AGENT_DOWNLOAD_BASE_URL) {
	$env:PRIME_AGENT_DOWNLOAD_BASE_URL.TrimEnd("/")
} else {
	$unconfiguredBaseUrl
}
$defaultChannel = "__PRIME_AGENT_DEFAULT_RELEASE_CHANNEL__"
if ($defaultChannel -eq $unconfiguredDefaultChannel) {
	$defaultChannel = "stable"
}
$releaseChannel = if ($env:PRIME_AGENT_RELEASE_CHANNEL) { $env:PRIME_AGENT_RELEASE_CHANNEL } else { $defaultChannel }
$packageName = if ($env:PRIME_AGENT_PACKAGE) { $env:PRIME_AGENT_PACKAGE } else { "prime-agent" }
$commandName = if ($env:PRIME_AGENT_CMD) { $env:PRIME_AGENT_CMD } else { "piloom" }
$releaseSigningKeyId = "piloom-release-2026-08"
$releaseSigningAlgorithm = "RSA-SHA256"
# SHA-256 fingerprint of the DER-encoded public key: 8HCpYV2gRRgDYCmdPqQGEG4G257XghPRpzMmbQG3DU4=
$releaseSigningModulus = "xVa8+RGteyJqLVxbCg6Grp3awVN1ROmGWLpnQr2FUuAnq6WO+vY5jHABxpFhBZZDdzLmfJuy9LYikL8hLpHvuL8ip9LWHHhE6+AkDjdVYW0x5AWezdKHhf+1qxtwMeGxBJFwhbrMlwZL6qM140c/aH+RRivHWmRhUTignNhvn/AJiuZmm23yDK3FqqEC7QEnXabyreg4cPMfxHHMyklkowTHOz3gcSnxSj2cYgC9EFNtWqJZHk0deT77ZmaZ5De7pAEkQnqrn7zmQCc2k9+Rgg1jiAd7re6iH1RFNwmNysgaVGQz9lIKzAw3AslJKyunmrlvAXI8UMJBdDoU2YGtZ6HiLWyKrapw++ozFHGuJvgQWDQxfKQrTu9+Nc7cvkPblEu1jNV/dYPHINAoVkJboChkEA16Mz05yYL2alrEZ9SHBrY8nbqR8Tnw7Go8kY5dV/3QsdfxT/Ny89aI9whaTWsHWwCfREWoCkirgRdV0WGXMTRJ28ap9qdJcMa5Regb"
$releaseSigningExponent = "AQAB"

function Fail([string]$Message) {
	Write-Error $Message
	exit 1
}

function Write-Step([string]$Message) {
	Write-Host "`n$Message" -ForegroundColor Cyan
}

function Invoke-SecureWebRequest([string]$Uri, [string]$OutFile = "") {
	$parsedUri = $null
	if (-not [Uri]::TryCreate($Uri, [UriKind]::Absolute, [ref]$parsedUri)) {
		throw "Invalid download URL: $Uri"
	}
	if ($parsedUri.Scheme -ne "https" -and $env:PRIME_AGENT_ALLOW_INSECURE_DOWNLOADS -ne "1") {
		throw "The installer requires HTTPS downloads: $Uri"
	}
	$request = @{
		Uri = $parsedUri
		UseBasicParsing = $true
		MaximumRedirection = 0
		ErrorAction = "Stop"
	}
	if (-not [string]::IsNullOrWhiteSpace($OutFile)) {
		$request.OutFile = $OutFile
	}
	return Invoke-WebRequest @request
}

function Verify-ReleaseSignature([string]$ChecksumPath, [string]$SignaturePath, [string]$ExpectedVersion, [string]$ExpectedChannel) {
	$signatureFile = Get-Item -LiteralPath $SignaturePath
	if ($signatureFile.Length -gt 16384) {
		throw "Release signature envelope is too large."
	}

	try {
		$envelope = Get-Content -LiteralPath $SignaturePath -Raw | ConvertFrom-Json
	} catch {
		throw "Release signature envelope is not valid JSON."
	}
	if ($envelope -isnot [PSCustomObject]) {
		throw "Release signature envelope must be an object."
	}
	$fields = @($envelope.PSObject.Properties.Name | Sort-Object)
	$expectedFields = @("algorithm", "channel", "keyId", "releaseVersion", "signature", "version")
	if ($fields.Count -ne $expectedFields.Count -or (Compare-Object $fields $expectedFields)) {
		throw "Release signature envelope has unexpected fields."
	}
	if ($envelope.version -ne 1) {
		throw "Unsupported release signature version: $($envelope.version)"
	}
	if ($envelope.keyId -ne $releaseSigningKeyId) {
		throw "Unexpected release signing key: $($envelope.keyId)"
	}
	if ($envelope.algorithm -ne $releaseSigningAlgorithm) {
		throw "Unsupported release signature algorithm: $($envelope.algorithm)"
	}
	if ($envelope.channel -ne $ExpectedChannel) {
		throw "Unexpected release channel: $($envelope.channel)"
	}
	if ($envelope.releaseVersion -ne $ExpectedVersion) {
		throw "Unexpected signed release version: $($envelope.releaseVersion)"
	}
	if ($envelope.signature -isnot [string] -or $envelope.signature.Length -eq 0 -or $envelope.signature.Length -gt 16384) {
		throw "Release signature is invalid."
	}

	try {
		$signatureBytes = [Convert]::FromBase64String($envelope.signature)
	} catch {
		throw "Release signature is not valid base64."
	}
	if ([Convert]::ToBase64String($signatureBytes) -ne $envelope.signature) {
		throw "Release signature is not canonical base64."
	}

	$parameters = New-Object System.Security.Cryptography.RSAParameters
	$parameters.Modulus = [Convert]::FromBase64String($releaseSigningModulus)
	$parameters.Exponent = [Convert]::FromBase64String($releaseSigningExponent)
	$rsa = New-Object System.Security.Cryptography.RSACryptoServiceProvider
	try {
		$rsa.PersistKeyInCsp = $false
		$rsa.ImportParameters($parameters)
		$checksumBytes = [System.IO.File]::ReadAllBytes($ChecksumPath)
		$contextBytes = [System.Text.Encoding]::UTF8.GetBytes("piloom-release-signature-v1`0$ExpectedChannel`0$ExpectedVersion`0")
		$signedBytes = New-Object byte[] ($contextBytes.Length + $checksumBytes.Length)
		[System.Buffer]::BlockCopy($contextBytes, 0, $signedBytes, 0, $contextBytes.Length)
		[System.Buffer]::BlockCopy($checksumBytes, 0, $signedBytes, $contextBytes.Length, $checksumBytes.Length)
		$sha256Oid = [System.Security.Cryptography.CryptoConfig]::MapNameToOID("SHA256")
		if (-not $rsa.VerifyData($signedBytes, $sha256Oid, $signatureBytes)) {
			throw "Release signature verification failed for $ChecksumPath."
		}
	} finally {
		$rsa.Dispose()
	}
}

function Normalize-Version([string]$Value) {
	$normalized = $Value.Trim()
	if ($normalized.StartsWith("v")) {
		$normalized = $normalized.Substring(1)
	}
	if ([string]::IsNullOrWhiteSpace($normalized) -or $normalized -notmatch '^[0-9A-Za-z.-]+$') {
		throw "Invalid PiLoom release version: $Value"
	}
	return $normalized
}

function Confirm-Install([string]$Version, [string]$TarballUrl) {
	if ($env:PRIME_AGENT_YES -eq "1" -or $env:PRIME_AGENT_NONINTERACTIVE -eq "1") {
		return $true
	}

	Write-Host "`nPiLoom v$Version will be downloaded, verified, and installed globally with npm."
	Write-Host $TarballUrl -ForegroundColor DarkGray
	$answer = Read-Host "Continue? [Y/n]"
	return [string]::IsNullOrWhiteSpace($answer) -or $answer -match '^(?i)y(es)?$'
}

function Confirm-KernelBootstrap {
	if ($env:PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL -eq "1") { return $true }
	if ($env:PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL -eq "0" -or $env:PRIME_AGENT_NONINTERACTIVE -eq "1") { return $false }

	$answer = Read-Host "Prepare the IPython runtime now (uv, Python 3.11, and packages)? [y/N]"
	return $answer -match '^(?i)y(es)?$'
}

function Get-RequiredCommand([string]$Name) {
	$command = @(Get-Command $Name -All -ErrorAction SilentlyContinue) |
		Where-Object { $_.CommandType -eq "Application" } |
		Select-Object -First 1
	if (-not $command) {
		$command = Get-Command $Name -ErrorAction SilentlyContinue
	}
	if (-not $command) {
		throw "$Name is required. Install Node.js 22.8.0 or newer, then run this installer again."
	}
	return $command
}

function Assert-NodeVersion {
	$node = Get-RequiredCommand "node"
	$rawVersion = (& $node.Source --version).Trim()
	if ($rawVersion -notmatch '^v(\d+)\.(\d+)\.(\d+)') {
		throw "Could not determine the installed Node.js version from '$rawVersion'."
	}

	$major = [int]$Matches[1]
	$minor = [int]$Matches[2]
	$patch = [int]$Matches[3]
	if ($major -lt 22 -or ($major -eq 22 -and ($minor -lt 8 -or ($minor -eq 8 -and $patch -lt 0)))) {
		throw "Node.js 22.8.0 or newer is required; found $rawVersion."
	}

	Get-RequiredCommand "npm" | Out-Null
}

function Add-UserPathEntry([string]$Directory) {
	$normalizedDirectory = [System.IO.Path]::GetFullPath($Directory).TrimEnd("\")
	$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
	$userEntries = @($userPath -split ";" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
	if (-not ($userEntries | Where-Object { $_.TrimEnd("\").Equals($normalizedDirectory, [System.StringComparison]::OrdinalIgnoreCase) })) {
		$updatedUserPath = (@($userEntries) + $normalizedDirectory) -join ";"
		[Environment]::SetEnvironmentVariable("Path", $updatedUserPath, "User")
	}

	$processEntries = @($env:Path -split ";" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
	if (-not ($processEntries | Where-Object { $_.TrimEnd("\").Equals($normalizedDirectory, [System.StringComparison]::OrdinalIgnoreCase) })) {
		$env:Path = (@($processEntries) + $normalizedDirectory) -join ";"
	}
}

function Ensure-CommandAvailable($Npm, [string]$Name) {
	$globalPrefix = (& $Npm.Source prefix --global).Trim()
	if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($globalPrefix)) {
		throw "npm prefix --global failed; the PiLoom command location could not be determined."
	}

	$commandShim = Join-Path $globalPrefix "$Name.cmd"
	if (-not (Test-Path -LiteralPath $commandShim -PathType Leaf)) {
		throw "The installed package did not create the expected command shim: $commandShim"
	}

	if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
		Add-UserPathEntry $globalPrefix
	}
	if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
		throw "PiLoom was installed, but '$Name' is still unavailable on PATH."
	}
}

function Resolve-Version {
	if ($env:PRIME_AGENT_VERSION) {
		return Normalize-Version $env:PRIME_AGENT_VERSION
	}

	if ($releaseChannel -notin @("stable", "beta")) {
		throw "Invalid PiLoom release channel: $releaseChannel"
	}

	$channelUrl = "$baseUrl/$releaseChannel"
	Write-Step "Resolving the $releaseChannel release"
	$response = Invoke-SecureWebRequest -Uri $channelUrl
	return Normalize-Version $response.Content
}

function Get-Checksum([string]$ChecksumPath, [string]$FileName) {
	$line = Get-Content -LiteralPath $ChecksumPath | Where-Object {
		$parts = $_ -split '\s+', 3
		$parts.Count -ge 2 -and $parts[1] -eq $FileName
	} | Select-Object -First 1
	if (-not $line) {
		throw "Checksum for $FileName was not found in $ChecksumPath."
	}
	return (($line -split '\s+', 3)[0]).ToLowerInvariant()
}

function Verify-Checksum([string]$ChecksumPath, [string]$TarballPath) {
	$expected = Get-Checksum $ChecksumPath ([System.IO.Path]::GetFileName($TarballPath))
	$actual = (Get-FileHash -LiteralPath $TarballPath -Algorithm SHA256).Hash.ToLowerInvariant()
	if ($actual -ne $expected) {
		throw "SHA-256 verification failed for $TarballPath."
	}
}

if ($baseUrl -eq $unconfiguredBaseUrl) {
	Fail "The installer download URL is not configured. Set PRIME_AGENT_DOWNLOAD_BASE_URL or use the installer published by the release workflow."
}
$downloadBaseUri = $null
if (-not [Uri]::TryCreate($baseUrl, [UriKind]::Absolute, [ref]$downloadBaseUri)) {
	Fail "The installer download URL is invalid: $baseUrl"
}
if ($downloadBaseUri.Scheme -ne "https" -and $env:PRIME_AGENT_ALLOW_INSECURE_DOWNLOADS -ne "1") {
	Fail "The installer requires HTTPS downloads. Set PRIME_AGENT_ALLOW_INSECURE_DOWNLOADS=1 only for local development."
}

try {
	Assert-NodeVersion
	$version = Resolve-Version
	$tarballName = "$packageName-$version.tgz"
	$tarballUrl = "$baseUrl/releases/v$version/$tarballName"

	if (-not (Confirm-Install $version $tarballUrl)) {
		Write-Host "Installation cancelled."
		exit 0
	}

	$temporaryDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("piloom-install-" + [guid]::NewGuid().ToString("N"))
	New-Item -ItemType Directory -Path $temporaryDirectory -Force | Out-Null
	try {
		$checksumPath = Join-Path $temporaryDirectory "SHA256SUMS"
		$signaturePath = Join-Path $temporaryDirectory "SHA256SUMS.sig"
		$tarballPath = Join-Path $temporaryDirectory $tarballName

		Write-Step "Downloading and verifying PiLoom v$version"
		Invoke-SecureWebRequest -Uri "$baseUrl/releases/v$version/SHA256SUMS" -OutFile $checksumPath | Out-Null
		Invoke-SecureWebRequest -Uri "$baseUrl/releases/v$version/SHA256SUMS.sig" -OutFile $signaturePath | Out-Null
		Verify-ReleaseSignature $checksumPath $signaturePath $version $releaseChannel
		Invoke-SecureWebRequest -Uri $tarballUrl -OutFile $tarballPath | Out-Null
		Verify-Checksum $checksumPath $tarballPath

		$env:PRIME_AGENT_BOOTSTRAP_TOOLS_ON_INSTALL = "1"
		if (Confirm-KernelBootstrap) {
			$env:PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL = "1"
			$env:PRIME_AGENT_INSTALL_UV = "1"
		}

		Write-Step "Installing PiLoom globally"
		$npm = Get-RequiredCommand "npm"
		& $npm.Source install --global --no-fund --no-audit --loglevel=error --progress=false $tarballPath
		if ($LASTEXITCODE -ne 0) {
			throw "npm install failed with exit code $LASTEXITCODE."
		}
		Ensure-CommandAvailable $npm $commandName
	} finally {
		if (Test-Path -LiteralPath $temporaryDirectory) {
			Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force
		}
	}

	Write-Host "`nPiLoom v$version was installed successfully." -ForegroundColor Green
	Write-Host "Run it with: $commandName"
} catch {
	Fail $_.Exception.Message
}
