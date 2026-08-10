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

function Fail([string]$Message) {
	Write-Error $Message
	exit 1
}

function Write-Step([string]$Message) {
	Write-Host "`n$Message" -ForegroundColor Cyan
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
	$response = Invoke-WebRequest -Uri $channelUrl -UseBasicParsing
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
		$tarballPath = Join-Path $temporaryDirectory $tarballName

		Write-Step "Downloading and verifying PiLoom v$version"
		Invoke-WebRequest -Uri "$baseUrl/releases/v$version/SHA256SUMS" -OutFile $checksumPath -UseBasicParsing
		Invoke-WebRequest -Uri $tarballUrl -OutFile $tarballPath -UseBasicParsing
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
