param(
	[string]$OutputDirectory = "",
	[string]$Version = ""
)

$ErrorActionPreference = "Stop"

function Invoke-Checked([string]$Command, [string[]]$Arguments) {
	& $Command @Arguments
	if ($LASTEXITCODE -ne 0) {
		throw "$Command failed with exit code $LASTEXITCODE."
	}
}

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $scriptRoot "..")
$packageDirectory = Join-Path $repoRoot "packages\coding-agent"
$distDirectory = Join-Path $packageDirectory "dist"
$stageDirectory = Join-Path $packageDirectory "binaries\windows-x64"
$outputRoot = if ($OutputDirectory) {
		[System.IO.Path]::GetFullPath($OutputDirectory)
	} else {
		Join-Path $packageDirectory "binaries"
	}
$archiveName = if ($Version) { "piloom-$Version-windows-x64.zip" } else { "piloom-windows-x64.zip" }
$archivePath = Join-Path $outputRoot $archiveName

Push-Location $repoRoot
try {
	foreach ($packageName in @("tui", "ai", "agent")) {
		$workspacePackage = Join-Path $repoRoot "packages\$packageName"
		Invoke-Checked "npm.cmd" @("--prefix", $workspacePackage, "run", "build")
	}
	Invoke-Checked "npm.cmd" @("--prefix", $packageDirectory, "run", "build")
	Invoke-Checked "bun" @(
		"build",
		"--compile",
		"--external",
		"koffi",
		"--target=bun-windows-x64",
		(Join-Path $packageDirectory "dist\bun\cli.js"),
		"--outfile",
		(Join-Path $packageDirectory "dist\piloom.exe")
	)
	Invoke-Checked "npm.cmd" @("--prefix", $packageDirectory, "run", "copy-binary-assets")

	$binaryCandidates = @(
		(Join-Path $distDirectory "piloom.exe"),
		(Join-Path $distDirectory "piloom")
	)
	$binaryPath = $binaryCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
	if (-not $binaryPath) {
		throw "Bun did not produce a Windows executable in $distDirectory."
	}

	if (Test-Path -LiteralPath $stageDirectory) {
		Remove-Item -LiteralPath $stageDirectory -Recurse -Force
	}
	New-Item -ItemType Directory -Path $stageDirectory -Force | Out-Null
	Copy-Item -Path (Join-Path $distDirectory "*") -Destination $stageDirectory -Recurse -Force

	if (-not (Test-Path -LiteralPath (Join-Path $stageDirectory (Split-Path -Leaf $binaryPath)) -PathType Leaf)) {
		throw "The staged Windows archive is missing the executable."
	}

	$koffiSource = Join-Path $repoRoot "node_modules\koffi"
	$koffiStage = Join-Path $stageDirectory "node_modules\koffi"
	$koffiNativeSource = Join-Path $koffiSource "build\koffi\win32_x64\koffi.node"
	if (-not (Test-Path -LiteralPath $koffiNativeSource -PathType Leaf)) {
		throw "The Windows koffi native binding is missing from node_modules."
	}
	New-Item -ItemType Directory -Path $koffiStage -Force | Out-Null
	Copy-Item -LiteralPath (Join-Path $koffiSource "index.js") -Destination $koffiStage -Force
	Copy-Item -LiteralPath (Join-Path $koffiSource "package.json") -Destination $koffiStage -Force
	New-Item -ItemType Directory -Path (Join-Path $koffiStage "build\koffi\win32_x64") -Force | Out-Null
	Copy-Item -LiteralPath $koffiNativeSource -Destination (Join-Path $koffiStage "build\koffi\win32_x64") -Force

	New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
	if (Test-Path -LiteralPath $archivePath) {
		Remove-Item -LiteralPath $archivePath -Force
	}
	Compress-Archive -Path (Join-Path $stageDirectory "*") -DestinationPath $archivePath -CompressionLevel Optimal

	$smokeDirectory = Join-Path $outputRoot ".piloom-smoke-$PID"
	try {
		Expand-Archive -LiteralPath $archivePath -DestinationPath $smokeDirectory -Force
		$smokeBinary = Join-Path $smokeDirectory (Split-Path -Leaf $binaryPath)
		if (-not (Test-Path -LiteralPath $smokeBinary -PathType Leaf)) {
			throw "The extracted Windows archive is missing the executable."
		}
		Invoke-Checked $smokeBinary @("--version")
	} finally {
		if (Test-Path -LiteralPath $smokeDirectory) {
			Remove-Item -LiteralPath $smokeDirectory -Recurse -Force
		}
	}

	$archiveHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
	Set-Content -LiteralPath "$archivePath.sha256" -Value "$archiveHash  $archiveName" -Encoding ascii
	Write-Host "Created $archivePath"
} finally {
	Pop-Location
}
