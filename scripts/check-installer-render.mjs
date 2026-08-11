import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const installerSource = readFileSync("install.sh", "utf-8");
const powershellInstallerSource = readFileSync("install.ps1", "utf-8");
const isWindows = process.platform === "win32";
const mainCall = '\nmain "$@"';
const mainCallIndex = installerSource.lastIndexOf(mainCall);
const ansiPattern = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const syncEnd = "\x1b[?2026l";
const failures = [];

check(installerSource.includes('prime_agent_cmd="${PRIME_AGENT_CMD:-piloom}"'), "POSIX installer must expose piloom as the default command");
check(installerSource.includes("verify_prime_agent_release_signature"), "POSIX installer must verify signed release checksums");
check(installerSource.includes('signature_url="$checksums_url.sig"'), "POSIX installer must download the release signature");
check(installerSource.includes('prime_agent_release_base_url="https://github.com/LiiLk/piloom"'), "POSIX installer must use the PiLoom GitHub repository as its release base");
check(installerSource.includes("prime_agent_is_trusted_release_url"), "POSIX installer must enforce its GitHub release redirect policy");
check(installerSource.includes("--max-redirs 0"), "POSIX installer must inspect release redirects itself");
check(installerSource.includes("release-assets.githubusercontent.com"), "POSIX installer must allow GitHub's release asset host");
check(
	installerSource.includes('*) release_channel="$prime_agent_release_channel" ;;'),
	"POSIX installer must select the active release channel before constructing asset URLs",
);
checkPowerShellInstaller(powershellInstallerSource);
checkRenderedReleaseChannels();

if (isWindows) {
	checkPowerShellSignatureFixture(powershellInstallerSource);
	checkPowerShellRedirectBehavior(powershellInstallerSource);
	if (failures.length > 0) {
		console.error(["Installer check failed:", ...failures.map((failure) => `- ${failure}`)].join("\n"));
		process.exit(1);
	}
	console.log("Installer check passed (PowerShell installer validated; POSIX render skipped on Windows).");
	process.exit(0);
}

if (mainCallIndex === -1) {
	console.error('Installer render check failed: could not find final main "$@" call.');
	process.exit(1);
}

checkPosixRedirectBehavior(installerSource, mainCallIndex);

const harnessSource = `${installerSource.slice(0, mainCallIndex)}

prime_agent_test_cols=80
prime_agent_test_rows=24

prime_agent_read_terminal_size() {
	prime_agent_screen_cols="$prime_agent_test_cols"
	prime_agent_screen_rows="$prime_agent_test_rows"
}

print_render_meta() {
	label="$1"
	if prime_agent_show_logo; then
		visible=1
	else
		visible=0
	fi
	content_height=$(prime_agent_content_height)
	printf '__META__ %s cols=%s rows=%s layout_show_logo=%s lab_width=%s render_lab_width=%s compact=%s visible=%s content_height=%s\\n' \\
		"$label" "$prime_agent_screen_cols" "$prime_agent_screen_rows" "$prime_agent_screen_layout_show_logo" \\
		"$prime_agent_screen_layout_lab_width" "$prime_agent_screen_render_lab_width" "$prime_agent_screen_compact" "$visible" "$content_height"
}

render_case() {
	prime_agent_screen_title="Installing PiLoom"
	prime_agent_screen_detail="Fetching the verified package."
	prime_agent_screen_question=
	prime_agent_screen_frame=1
	prime_agent_screen_cols="$1"
	prime_agent_screen_rows="$2"
	prime_agent_screen_layout_ready=0
	prime_agent_screen_layout_show_logo=0
	prime_agent_screen_layout_lab_width=0
	prime_agent_screen_render_lab_width=0
	prime_agent_screen_compact=0
	prime_agent_init_screen_layout
	prime_agent_refresh_screen_layout_mode
	print_render_meta first
	printf '__RENDER_START__ first\\n'
	prime_agent_render_screen
	printf '__RENDER_END__ first\\n'

	prime_agent_screen_frame=2
	prime_agent_screen_cols="$3"
	prime_agent_screen_rows="$4"
	prime_agent_refresh_screen_layout_mode
	print_render_meta second
	printf '__RENDER_START__ second\\n'
	prime_agent_render_screen
	printf '__RENDER_END__ second\\n'
}

screen_case() {
	prime_agent_screen_enabled=1
	prime_agent_screen_drawn=0
	prime_agent_screen_last_cols=0
	prime_agent_screen_last_rows=0
	prime_agent_screen_layout_ready=0
	prime_agent_screen_layout_show_logo=0
	prime_agent_screen_layout_lab_width=0
	prime_agent_screen_render_lab_width=0
	prime_agent_screen_compact=0
	prime_agent_screen_frame=0

	prime_agent_test_cols="$1"
	prime_agent_test_rows="$2"
	printf '__SCREEN_START__ first\\n' >&2
	prime_agent_screen "Installing PiLoom" "Installing PiLoom" "Fetching the verified package." ""
	printf '__SCREEN_END__ first\\n' >&2

	prime_agent_test_cols="$3"
	prime_agent_test_rows="$4"
	printf '__SCREEN_START__ second\\n' >&2
	prime_agent_screen "Installing PiLoom" "Installing PiLoom" "Fetching the verified package." ""
	printf '__SCREEN_END__ second\\n' >&2
}

progress_case() {
	progress_details="Preparing global install.
Linking command binaries.
Finalizing npm install."
	for progress_frame in 1 24 25 48 49 200; do
		prime_agent_animation_frame="$progress_frame"
		printf '__PROGRESS__ %s\t%s\t%s\\n' "$progress_frame" "$(prime_agent_animation_status "Installing PiLoom" "$progress_details" static)" "$(prime_agent_animation_detail "$progress_details")"
	done
}

redirect_policy_case() {
	for allowed_url in \
		"https://github.com/LiiLk/piloom/releases/latest/download/stable" \
		"https://release-assets.githubusercontent.com/github-production-release-asset/example" \
		"https://objects.githubusercontent.com/github-production-release-asset/example"; do
		if ! prime_agent_is_trusted_release_url "$allowed_url"; then
			printf 'redirect policy rejected allowed URL: %s\n' "$allowed_url" >&2
			exit 1
		fi
	done
	for rejected_url in \
		"http://github.com/LiiLk/piloom/releases/download/v0.0.0/SHA256SUMS" \
		"https://evil.example/releases/download/v0.0.0/SHA256SUMS" \
		"https://github.com:444/LiiLk/piloom/releases/download/v0.0.0/SHA256SUMS" \
		"https://user@github.com/LiiLk/piloom/releases/download/v0.0.0/SHA256SUMS"; do
		if prime_agent_is_trusted_release_url "$rejected_url"; then
			printf 'redirect policy accepted rejected URL: %s\n' "$rejected_url" >&2
			exit 1
		fi
	done
}

release_asset_case() {
	release_channel=stable
	stable_url=$(prime_agent_release_asset_url "1.2.3" "prime-agent-1.2.3.tgz")
	if [ "$stable_url" != "https://github.com/LiiLk/piloom/releases/download/v1.2.3/prime-agent-1.2.3.tgz" ]; then
		printf 'stable release URL is incorrect: %s\n' "$stable_url" >&2
		exit 1
	fi
	release_channel=beta
	beta_url=$(prime_agent_release_asset_url "1.2.3-beta.1" "prime-agent-1.2.3-beta.1.tgz")
	if [ "$beta_url" != "https://github.com/LiiLk/piloom/releases/download/beta/prime-agent-1.2.3-beta.1.tgz" ]; then
		printf 'beta release URL is incorrect: %s\n' "$beta_url" >&2
		exit 1
	fi
}

render_case "$@"
screen_case "$@"
progress_case
redirect_policy_case
release_asset_case
`;

const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-installer-render-"));
const harnessPath = join(tempDir, "harness.sh");

try {
	writeFileSync(harnessPath, harnessSource, "utf-8");

	const stableVisible = runCase("stable visible logo", 100, 30, 90, 30);
	check(stableVisible.meta.first.visible === "1", "expected the initial large render to show the logo");
	check(stableVisible.meta.second.visible === "1", "expected a safe resize to keep showing the logo");
	check(
		stableVisible.meta.first.lab_width === stableVisible.meta.second.lab_width,
		"expected logo lab width to stay stable across a safe resize",
	);
	assertInstallerProgress(stableVisible.progress);

	const stableExpand = runCase("stable expanded logo", 60, 24, 120, 32);
	check(stableExpand.meta.first.visible === "1", "expected the initial medium render to show the logo");
	check(stableExpand.meta.second.visible === "1", "expected terminal growth to keep showing the logo");
	check(
		stableExpand.meta.first.lab_width === stableExpand.meta.second.lab_width,
		"expected logo lab width not to grow after terminal expansion",
	);

	const noLogoStart = runCase("small initial terminal", 41, 24, 100, 30);
	check(noLogoStart.meta.first.layout_show_logo === "0", "expected a too-narrow initial terminal to freeze text-only layout");
	check(noLogoStart.meta.second.visible === "0", "expected terminal growth not to enable a logo after text-only layout was frozen");

	const narrowLogo = runCase("narrow logo on width shrink", 100, 30, 60, 24);
	check(narrowLogo.meta.first.visible === "1", "expected the initial wide render to show the logo");
	check(narrowLogo.meta.second.compact === "0", "expected shrink below frozen lab width to keep rendering the logo");
	check(narrowLogo.meta.second.visible === "1", "expected narrow width mode to keep showing the logo");
	check(
		Number(narrowLogo.meta.second.render_lab_width) <= 59,
		"expected narrow width mode to keep the rendered lab width inside the resized terminal",
	);

	const compactWidth = runCase("compact on severe width shrink", 100, 30, 32, 24);
	check(compactWidth.meta.first.visible === "1", "expected the initial wide render to show the logo");
	check(compactWidth.meta.second.compact === "1", "expected shrink below logo width to use compact mode");
	check(compactWidth.meta.second.visible === "0", "expected severe compact width mode to hide the logo");

	const compactRows = runCase("compact on row shrink", 100, 30, 100, 10);
	check(compactRows.meta.first.visible === "1", "expected the initial tall render to show the logo");
	check(compactRows.meta.second.compact === "1", "expected shrink below frozen splash height to use compact mode");
	check(compactRows.meta.second.visible === "0", "expected compact row mode to hide the logo");
} finally {
	rmSync(tempDir, { recursive: true, force: true });
}

if (failures.length > 0) {
	console.error(["Installer render check failed:", ...failures.map((failure) => `- ${failure}`)].join("\n"));
	process.exit(1);
}

console.log("Installer render check passed.");

function runCase(name, initialCols, initialRows, resizedCols, resizedRows) {
	const result = spawnSync("sh", [harnessPath, String(initialCols), String(initialRows), String(resizedCols), String(resizedRows)], {
		detached: true,
		encoding: "utf-8",
	});
	if (result.status !== 0) {
		failures.push(`${name}: harness exited with ${result.status ?? "unknown"}\n${result.stderr}${result.stdout}`);
		return emptyParsedCase();
	}

	const parsed = parseRenderOutput(result.stdout);
	parsed.screens = parseScreenOutput(result.stderr);
	assertLineWidths(name, "first", parsed, initialCols, initialRows);
	assertLineWidths(name, "second", parsed, resizedCols, resizedRows);
	assertScreenFrame(name, "first", parsed, initialCols, initialRows);
	assertScreenFrame(name, "second", parsed, resizedCols, resizedRows);
	return parsed;
}

function parseRenderOutput(output) {
	const parsed = emptyParsedCase();
	let activeRender = null;

	for (const rawLine of output.split("\n")) {
		const line = rawLine.replace(/\r$/, "");
		if (line.startsWith("__META__ ")) {
			const [, label, ...fields] = line.split(" ");
			parsed.meta[label] = Object.fromEntries(fields.map((field) => field.split("=")));
			continue;
		}
		if (line.startsWith("__RENDER_START__ ")) {
			activeRender = line.slice("__RENDER_START__ ".length);
			parsed.renders[activeRender] = [];
			continue;
		}
		if (line.startsWith("__RENDER_END__ ")) {
			activeRender = null;
			continue;
		}
		if (line.startsWith("__PROGRESS__ ")) {
			const [frame, status, detail] = line.slice("__PROGRESS__ ".length).split("\t");
			parsed.progress.push({ frame: Number(frame), status, detail });
			continue;
		}
		if (activeRender) {
			parsed.renders[activeRender].push(line.replace(ansiPattern, ""));
		}
	}

	return parsed;
}

function parseScreenOutput(output) {
	const screens = {};
	for (const label of ["first", "second"]) {
		const startToken = `__SCREEN_START__ ${label}\n`;
		const endToken = `__SCREEN_END__ ${label}\n`;
		const startIndex = output.indexOf(startToken);
		if (startIndex === -1) {
			failures.push(`missing ${label} screen start marker`);
			continue;
		}
		const contentStart = startIndex + startToken.length;
		const endIndex = output.indexOf(endToken, contentStart);
		if (endIndex === -1) {
			failures.push(`missing ${label} screen end marker`);
			continue;
		}
		screens[label] = output.slice(contentStart, endIndex);
	}
	return screens;
}

function assertInstallerProgress(progress) {
	check(progress.length === 6, `expected six progress samples, got ${progress.length}`);
	if (progress.length !== 6) return;

	const expectedDetails = [
		"Preparing global install.",
		"Preparing global install.",
		"Linking command binaries.",
		"Linking command binaries.",
		"Finalizing npm install.",
		"Finalizing npm install.",
	];
	for (const [index, expectedDetail] of expectedDetails.entries()) {
		check(
			progress[index].detail === expectedDetail,
			`expected progress sample ${index + 1} to show "${expectedDetail}", got "${progress[index].detail}"`,
		);
		check(
			progress[index].status === "Installing PiLoom...",
			`expected progress sample ${index + 1} to use indeterminate status`,
		);
		check(!progress[index].status.includes("%"), `expected progress sample ${index + 1} not to include a percent`);
	}
}

function assertLineWidths(name, label, parsed, cols, rows) {
	const lines = parsed.renders[label] ?? [];
	check(lines.length === rows, `${name}: expected ${label} render to have ${rows} rows, got ${lines.length}`);

	const maxWidth = Math.max(cols - 1, 0);
	for (const [index, line] of lines.entries()) {
		check(line.length <= maxWidth, `${name}: ${label} render line ${index + 1} reached ${line.length} columns in a ${cols}-column terminal`);
	}
}

function assertScreenFrame(name, label, parsed, cols, rows) {
	const screen = parsed.screens[label] ?? "";
	check(screen.endsWith(syncEnd), `${name}: expected ${label} screen frame to end with synchronized update close`);
	check(!screen.endsWith(`\n${syncEnd}`), `${name}: expected ${label} screen frame not to emit a trailing row newline`);
	check(countNewlines(screen) === rows - 1, `${name}: expected ${label} screen frame to contain ${rows - 1} line breaks`);

	const lines = screen.replace(ansiPattern, "").split("\n");
	check(lines.length === rows, `${name}: expected ${label} screen frame to contain ${rows} rows, got ${lines.length}`);
	const maxWidth = Math.max(cols - 1, 0);
	for (const [index, line] of lines.entries()) {
		check(line.length <= maxWidth, `${name}: ${label} screen line ${index + 1} reached ${line.length} columns in a ${cols}-column terminal`);
	}
}

function countNewlines(text) {
	let count = 0;
	for (const char of text) {
		if (char === "\n") count++;
	}
	return count;
}

function check(condition, message) {
	if (!condition) {
		failures.push(message);
	}
}

function checkPosixRedirectBehavior(source, sourceMainCallIndex) {
	const temporaryDirectory = mkdtempSync(join(tmpdir(), "piloom-installer-redirects-"));
	const harnessPath = join(temporaryDirectory, "redirects.sh");
	const fakeCurlPath = join(temporaryDirectory, "curl");
	const fakeCurl = `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const headerPath = args[args.indexOf("-D") + 1];
const outputPath = args[args.indexOf("-o") + 1];
const url = args.find((value) => value.startsWith("http"));
const responses = {
  "https://github.com/LiiLk/piloom/releases/download/beta/start": { status: 302, location: "https://release-assets.githubusercontent.com/github-production-release-asset/middle" },
  "https://release-assets.githubusercontent.com/github-production-release-asset/middle": { status: 307, location: "https://objects.githubusercontent.com/github-production-release-asset/final" },
  "https://objects.githubusercontent.com/github-production-release-asset/final": { status: 200, body: "allowed redirect payload\\n" },
  "https://github.com/LiiLk/piloom/releases/download/beta/rejected": { status: 302, location: "https://evil.example/rejected" },
  "https://github.com/LiiLk/piloom/releases/download/beta/downgrade": { status: 302, location: "http://github.com/LiiLk/piloom/releases/download/beta/final" },
};
for (let index = 0; index < 6; index += 1) {
  responses["https://release-assets.githubusercontent.com/github-production-release-asset/limit-" + index] = {
    status: 302,
    location: "https://release-assets.githubusercontent.com/github-production-release-asset/limit-" + (index + 1),
  };
}
responses["https://release-assets.githubusercontent.com/github-production-release-asset/limit-6"] = { status: 200, body: "too late\\n" };
const response = responses[url];
if (!response) process.exit(2);
writeFileSync(headerPath, "HTTP/1.1 " + response.status + " Test\\r\\n" + (response.location ? "Location: " + response.location + "\\r\\n" : "") + "\\r\\n");
if (response.body) writeFileSync(outputPath, response.body);
process.exit(response.status >= 300 && response.status < 400 ? 47 : 0);
`;
	writeFileSync(fakeCurlPath, fakeCurl, "utf-8");
	chmodSync(fakeCurlPath, 0o755);
	const run = (url, shouldSucceed, label) => {
		const outputPath = join(temporaryDirectory, `${label}-${Math.random().toString(16).slice(2)}.out`);
		const scenarioHarness = `${source.slice(0, sourceMainCallIndex)}
set -e
prime_agent_download_release_asset "${url}" "$1"
`;
		writeFileSync(harnessPath, scenarioHarness, "utf-8");
		const result = spawnSync("sh", [harnessPath, outputPath], {
			encoding: "utf-8",
			env: { ...process.env, PATH: `${temporaryDirectory}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}` },
		});
		check(
			shouldSucceed ? result.status === 0 : result.status !== 0,
			`POSIX redirect ${label} scenario returned ${result.status}: ${result.stderr || result.stdout}`,
		);
		return { result, outputPath };
	};
	try {
		const allowed = run("https://github.com/LiiLk/piloom/releases/download/beta/start", true, "allowed");
		if (allowed.result.status === 0) {
			check(readFileSync(allowed.outputPath, "utf-8") === "allowed redirect payload\n", "POSIX allowed redirect did not follow the complete chain");
		}
		run("https://github.com/LiiLk/piloom/releases/download/beta/rejected", false, "untrusted");
		run("https://github.com/LiiLk/piloom/releases/download/beta/downgrade", false, "downgrade");
		run("https://release-assets.githubusercontent.com/github-production-release-asset/limit-0", false, "limit");
	} finally {
		rmSync(temporaryDirectory, { recursive: true, force: true });
	}
}

function checkPowerShellRedirectBehavior(source) {
	const mainStart = source.indexOf("$downloadBaseUri = $null");
	if (mainStart === -1) {
		failures.push("PowerShell redirect check could not isolate its function definitions");
		return;
	}
	const temporaryDirectory = mkdtempSync(join(tmpdir(), "piloom-powershell-redirects-"));
	const harnessPath = join(temporaryDirectory, "redirects.ps1");
	const quotePowerShell = (value) => value.replaceAll("'", "''");
	const harness = `${source.slice(0, mainStart)}
$script:responses = @{
  'https://github.com/LiiLk/piloom/releases/latest/download/stable' = @{ Status = 302; Location = 'https://release-assets.githubusercontent.com/github-production-release-asset/stable'; Content = '' }
  'https://release-assets.githubusercontent.com/github-production-release-asset/stable' = @{ Status = 200; Location = ''; Content = '0.7.2' }
  'https://github.com/LiiLk/piloom/releases/download/beta/start' = @{ Status = 302; Location = 'https://release-assets.githubusercontent.com/github-production-release-asset/middle'; Content = '' }
  'https://release-assets.githubusercontent.com/github-production-release-asset/middle' = @{ Status = 307; Location = 'https://objects.githubusercontent.com/github-production-release-asset/final'; Content = '' }
  'https://objects.githubusercontent.com/github-production-release-asset/final' = @{ Status = 200; Location = ''; Content = 'allowed redirect payload' }
  'https://github.com/LiiLk/piloom/releases/download/beta/rejected' = @{ Status = 302; Location = 'https://evil.example/rejected'; Content = '' }
  'https://github.com/LiiLk/piloom/releases/download/beta/downgrade' = @{ Status = 302; Location = 'http://github.com/LiiLk/piloom/releases/download/beta/final'; Content = '' }
}
for ($index = 0; $index -le 6; $index++) {
  $script:responses["https://release-assets.githubusercontent.com/github-production-release-asset/limit-$index"] = @{ Status = 302; Location = "https://release-assets.githubusercontent.com/github-production-release-asset/limit-$($index + 1)"; Content = '' }
}
$script:responses['https://release-assets.githubusercontent.com/github-production-release-asset/limit-7'] = @{ Status = 200; Location = ''; Content = 'too late' }
function Invoke-WebRequestWithoutRedirect {
  param([Uri]$Uri, [string]$OutFile)
  $response = $script:responses[$Uri.AbsoluteUri]
  if (-not $response) { throw "missing fake response for $($Uri.AbsoluteUri)" }
  if ($OutFile -and $response.Status -ge 200 -and $response.Status -lt 300) { [System.IO.File]::WriteAllText($OutFile, $response.Content) }
  [PSCustomObject]@{ StatusCode = $response.Status; Location = $response.Location; Content = $response.Content }
}
function Assert-ScenarioRejected([string]$Uri, [string]$Label) {
  try { Invoke-SecureWebRequest -Uri $Uri | Out-Null } catch { return }
  throw "PowerShell redirect policy accepted $Label."
}
$outPath = '${quotePowerShell(join(temporaryDirectory, "allowed.out"))}'
$resolvedVersion = Resolve-Version
if ($resolvedVersion -ne '0.7.2') { throw "PowerShell stable release resolution returned '$resolvedVersion'." }
Invoke-SecureWebRequest -Uri 'https://github.com/LiiLk/piloom/releases/download/beta/start' -OutFile $outPath | Out-Null
if ((Get-Content -LiteralPath $outPath -Raw) -ne 'allowed redirect payload') { throw 'PowerShell allowed redirect did not follow the complete chain.' }
Assert-ScenarioRejected 'https://github.com/LiiLk/piloom/releases/download/beta/rejected' 'an untrusted host'
Assert-ScenarioRejected 'https://github.com/LiiLk/piloom/releases/download/beta/downgrade' 'an HTTP downgrade'
Assert-ScenarioRejected 'https://release-assets.githubusercontent.com/github-production-release-asset/limit-0' 'an excessive redirect chain'
`;
	writeFileSync(harnessPath, harness, "utf-8");
	try {
		const result = spawnSync(
			"powershell.exe",
			["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", harnessPath],
			{ encoding: "utf8" },
		);
		if (result.status !== 0) {
			failures.push(`PowerShell redirect fixture failed: ${(result.stderr || result.stdout).trim()}`);
		}
	} finally {
		rmSync(temporaryDirectory, { recursive: true, force: true });
	}
}

function checkPowerShellInstaller(source) {
	check(source.includes('$baseUrl = "https://github.com/LiiLk/piloom"'), "PowerShell installer must use the PiLoom GitHub repository as its release base");
	check(source.includes('$unconfiguredDefaultChannel = "__PRIME_AGENT_DEFAULT_RELEASE_" + "CHANNEL__"'), "PowerShell installer is missing the release channel sentinel");
	check(source.includes('$defaultChannel = "__PRIME_AGENT_DEFAULT_RELEASE_CHANNEL__"'), "PowerShell installer is missing the default release channel placeholder");
	check(source.includes("[System.Net.HttpWebRequest]::Create"), "PowerShell installer must use the Windows-compatible HTTP request API");
	check(source.includes("AllowAutoRedirect = $false"), "PowerShell installer must inspect redirects before following them");
	check(!source.includes("Invoke-WebRequest @request"), "PowerShell installer must not rely on broken PowerShell 5.1 zero-redirect handling");
	check(source.includes("Assert-TrustedReleaseBaseUri"), "PowerShell installer must validate its exact GitHub release base URL");
	check(source.includes("Assert-TrustedReleaseUri"), "PowerShell installer must enforce its GitHub release redirect policy");
	check(source.includes("release-assets.githubusercontent.com"), "PowerShell installer must allow GitHub's release asset host");
	check(source.includes("Get-FileHash"), "PowerShell installer must verify SHA-256 checksums");
	check(source.includes('Get-ReleaseAssetUrl $version "SHA256SUMS.sig"'), "PowerShell installer must download the release signature");
	check(source.includes("RSACryptoServiceProvider"), "PowerShell installer must verify the checksum manifest with its embedded RSA public key");
	check(source.includes('$releaseSigningKeyId = "piloom-release-2026-08"'), "PowerShell installer is missing the expected release signing key ID");
	check(
		source.includes("Verify-ReleaseSignature $checksumPath $signaturePath"),
		"PowerShell installer must authenticate the checksum manifest",
	);
	check(
		source.indexOf("Verify-ReleaseSignature $checksumPath $signaturePath") < source.indexOf("Verify-Checksum $checksumPath $tarballPath"),
		"PowerShell installer must authenticate the checksum manifest before trusting its archive hash",
	);
	check(source.includes('$ParsedUri.Scheme -ne "https"'), "PowerShell installer must require HTTPS downloads");
	check(!source.includes("PRIME_AGENT_ALLOW_INSECURE_DOWNLOADS"), "PowerShell installer must not allow insecure download opt-outs");
	check(source.includes("install --global"), "PowerShell installer must install the package globally with npm");
	check(source.includes('else { "piloom" }'), "PowerShell installer must expose piloom as the default command");
	check(source.includes("npm prefix --global"), "PowerShell installer must resolve npm's global command directory");
	check(source.includes('[Environment]::SetEnvironmentVariable("Path"'), "PowerShell installer must persist a missing user PATH entry");
	check(source.includes('"$Name.cmd"'), "PowerShell installer must verify the generated Windows command shim");
	check(source.includes("[guid]::NewGuid"), "PowerShell installer must use a unique temporary directory");
	check(source.includes("Remove-Item -LiteralPath $temporaryDirectory"), "PowerShell installer must clean up its temporary directory");
	check(!source.includes("curl -LsSf") && !source.includes("install.sh"), "PowerShell installer must not depend on the POSIX installer");
}

function checkRenderedReleaseChannels() {
	for (const channel of ["stable", "beta"]) {
		const renderedPosix = installerSource.replaceAll("__PRIME_AGENT_DEFAULT_RELEASE_CHANNEL__", channel);
		const renderedPowerShell = powershellInstallerSource.replaceAll("__PRIME_AGENT_DEFAULT_RELEASE_CHANNEL__", channel);
		check(!renderedPosix.includes("__PRIME_AGENT_DEFAULT_RELEASE_CHANNEL__"), `POSIX ${channel} installer still contains a release channel placeholder`);
		check(!renderedPowerShell.includes("__PRIME_AGENT_DEFAULT_RELEASE_CHANNEL__"), `PowerShell ${channel} installer still contains a release channel placeholder`);
		const expectedMarker = channel === "stable" ? "/releases/latest/download/stable" : "/releases/download/beta/beta";
		check(renderedPosix.includes(expectedMarker), `POSIX ${channel} installer must resolve its GitHub release marker`);
		check(renderedPowerShell.includes(expectedMarker), `PowerShell ${channel} installer must resolve its GitHub release marker`);
	}
}

function checkPowerShellSignatureFixture(source) {
	const mainStart = source.indexOf("$downloadBaseUri = $null");
	if (mainStart === -1) {
		failures.push("PowerShell installer check could not isolate its function definitions");
		return;
	}

	const temporaryDirectory = mkdtempSync(join(tmpdir(), "piloom-installer-signature-"));
	const harnessPath = join(temporaryDirectory, "verify-signature.ps1");
	const fixtureDirectory = join(process.cwd(), "scripts", "fixtures", "release-signing");
	const quotePowerShell = (value) => value.replaceAll("'", "''");
	const harness = `${source.slice(0, mainStart)}
$fixtureDirectory = '${quotePowerShell(fixtureDirectory)}'
$checksumPath = Join-Path $fixtureDirectory 'SHA256SUMS'
$signaturePath = Join-Path $fixtureDirectory 'SHA256SUMS.sig'
Verify-ReleaseSignature $checksumPath $signaturePath '0.0.0' 'stable'
Assert-TrustedReleaseBaseUri ([Uri]'https://github.com/LiiLk/piloom')
Assert-TrustedReleaseBaseUri ([Uri]'https://github.com/LiiLk/piloom/')
Assert-TrustedReleaseUri ([Uri]'https://github.com/LiiLk/piloom/releases/download/v0.0.0/SHA256SUMS')
Assert-TrustedReleaseUri ([Uri]'https://release-assets.githubusercontent.com/github-production-release-asset/example')
function Assert-BaseUriRejected([string]$Uri, [string]$Label) {
	try {
		Assert-TrustedReleaseBaseUri ([Uri]$Uri)
	} catch {
		return
	}
	throw "Release base URL policy accepted $Label."
}
Assert-BaseUriRejected 'http://github.com/LiiLk/piloom' 'an HTTP base URL'
Assert-BaseUriRejected 'https://evil.example/LiiLk/piloom' 'an untrusted base host'
Assert-BaseUriRejected 'https://github.com:444/LiiLk/piloom' 'a non-default base port'
Assert-BaseUriRejected 'https://user@github.com/LiiLk/piloom' 'base URL userinfo'
Assert-BaseUriRejected 'https://github.com/LiiLk/piloom/releases' 'a broader release path'
Assert-BaseUriRejected 'https://github.com/LiiLk/piloom?download=1' 'a base URL query'
Assert-BaseUriRejected 'https://github.com/LiiLk/piloom#release' 'a base URL fragment'
Assert-BaseUriRejected 'https://github.com/liilk/piloom' 'a differently cased repository path'
function Assert-UriRejected([string]$Uri, [string]$Label) {
	try {
		Assert-TrustedReleaseUri ([Uri]$Uri)
	} catch {
		return
	}
	throw "Release URL policy accepted $Label."
}
Assert-UriRejected 'http://github.com/LiiLk/piloom/releases/download/v0.0.0/SHA256SUMS' 'an HTTP downgrade'
Assert-UriRejected 'https://evil.example/releases/download/v0.0.0/SHA256SUMS' 'an untrusted host'
Assert-UriRejected 'https://github.com:444/LiiLk/piloom/releases/download/v0.0.0/SHA256SUMS' 'a non-default port'
Assert-UriRejected 'https://user@github.com/LiiLk/piloom/releases/download/v0.0.0/SHA256SUMS' 'userinfo'
function Assert-SignatureRejected([scriptblock]$Action, [string]$Label) {
	try {
		& $Action
	} catch {
		return
	}
	throw "Release signature check accepted $Label."
}
Assert-SignatureRejected { Verify-ReleaseSignature $checksumPath $signaturePath '0.0.0' 'beta' } 'a substituted channel'
Assert-SignatureRejected { Verify-ReleaseSignature $checksumPath $signaturePath '0.0.1' 'stable' } 'a substituted version'
$tamperedPath = Join-Path '${quotePowerShell(temporaryDirectory)}' 'SHA256SUMS.tampered'
Copy-Item -LiteralPath $checksumPath -Destination $tamperedPath
[System.IO.File]::AppendAllText($tamperedPath, 'tampered')
Assert-SignatureRejected { Verify-ReleaseSignature $tamperedPath $signaturePath '0.0.0' 'stable' } 'a tampered manifest'
foreach ($variant in @('keyId', 'algorithm', 'signature', 'version', 'extra')) {
	$variantEnvelope = Get-Content -LiteralPath $signaturePath -Raw | ConvertFrom-Json
	switch ($variant) {
		'keyId' { $variantEnvelope.keyId = 'wrong-key' }
		'algorithm' { $variantEnvelope.algorithm = 'wrong-algorithm' }
		'signature' { $variantEnvelope.signature = 'not-base64!' }
		'version' { $variantEnvelope.version = 2 }
		'extra' { $variantEnvelope | Add-Member -NotePropertyName extra -NotePropertyValue true }
	}
	$variantPath = Join-Path '${quotePowerShell(temporaryDirectory)}' "SHA256SUMS.$variant.sig"
	$variantEnvelope | ConvertTo-Json -Compress | Set-Content -LiteralPath $variantPath -Encoding UTF8
	Assert-SignatureRejected { Verify-ReleaseSignature $checksumPath $variantPath '0.0.0' 'stable' } "$variant variant"
}
$malformedPath = Join-Path '${quotePowerShell(temporaryDirectory)}' 'SHA256SUMS.malformed.sig'
Set-Content -LiteralPath $malformedPath -Value '{' -Encoding ASCII
Assert-SignatureRejected { Verify-ReleaseSignature $checksumPath $malformedPath '0.0.0' 'stable' } 'malformed JSON'
$oversizedPath = Join-Path '${quotePowerShell(temporaryDirectory)}' 'SHA256SUMS.oversized.sig'
[System.IO.File]::WriteAllText($oversizedPath, ('x' * 16385))
Assert-SignatureRejected { Verify-ReleaseSignature $checksumPath $oversizedPath '0.0.0' 'stable' } 'an oversized envelope'
`;
	writeFileSync(harnessPath, harness);
	try {
		const result = spawnSync(
			"powershell.exe",
			["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", harnessPath],
			{ encoding: "utf8" },
		);
		if (result.status !== 0) {
			failures.push(`PowerShell release signature fixture failed: ${(result.stderr || result.stdout).trim()}`);
		}
	} finally {
		rmSync(temporaryDirectory, { recursive: true, force: true });
	}
}

function emptyParsedCase() {
	return {
		meta: {
			first: {},
			second: {},
		},
		renders: {
			first: [],
			second: [],
		},
		screens: {},
		progress: [],
	};
}
