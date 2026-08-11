import { createHash, createPublicKey, createVerify } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { getPiUserAgent } from "./pi-user-agent.js";

export const PRIME_AGENT_RELEASE_BASE_URL = "https://github.com/LiiLk/piloom";
export const PRIME_AGENT_RELEASE_PACKAGE_NAME = "prime-agent";
const RELEASE_REPOSITORY_PATH = "/LiiLk/piloom/releases/";
const STABLE_VERSION_MANIFEST_PATH = "releases/latest/download/latest.json";
const BETA_VERSION_MANIFEST_PATH = "releases/download/beta/beta.json";
const DEFAULT_VERSION_CHECK_TIMEOUT_MS = 10000;
const MAX_RELEASE_REDIRECTS = 5;
const TRUSTED_RELEASE_ASSET_HOSTS = new Set(["release-assets.githubusercontent.com", "objects.githubusercontent.com"]);
const RELEASE_SIGNATURE_ALGORITHM = "RSA-SHA256";
const RELEASE_SIGNATURE_KEY_ID = "piloom-release-2026-08";
const RELEASE_SIGNATURE_CONTEXT = "piloom-release-signature-v1";
const RELEASE_SIGNING_PUBLIC_JWK = Object.freeze({
	kty: "RSA",
	n: "xVa8-RGteyJqLVxbCg6Grp3awVN1ROmGWLpnQr2FUuAnq6WO-vY5jHABxpFhBZZDdzLmfJuy9LYikL8hLpHvuL8ip9LWHHhE6-AkDjdVYW0x5AWezdKHhf-1qxtwMeGxBJFwhbrMlwZL6qM140c_aH-RRivHWmRhUTignNhvn_AJiuZmm23yDK3FqqEC7QEnXabyreg4cPMfxHHMyklkowTHOz3gcSnxSj2cYgC9EFNtWqJZHk0deT77ZmaZ5De7pAEkQnqrn7zmQCc2k9-Rgg1jiAd7re6iH1RFNwmNysgaVGQz9lIKzAw3AslJKyunmrlvAXI8UMJBdDoU2YGtZ6HiLWyKrapw--ozFHGuJvgQWDQxfKQrTu9-Nc7cvkPblEu1jNV_dYPHINAoVkJboChkEA16Mz05yYL2alrEZ9SHBrY8nbqR8Tnw7Go8kY5dV_3QsdfxT_Ny89aI9whaTWsHWwCfREWoCkirgRdV0WGXMTRJ28ap9qdJcMa5Regb",
	e: "AQAB",
});

export interface LatestPiRelease {
	version: string;
	channel: "stable" | "beta";
	packageName?: string;
	installSpec?: string;
}

interface ParsedVersion {
	major: number;
	minor: number;
	patch: number;
	prerelease?: string;
}

function comparePrereleaseIdentifiers(leftPrerelease: string, rightPrerelease: string): number {
	const leftIdentifiers = leftPrerelease.split(".");
	const rightIdentifiers = rightPrerelease.split(".");
	const length = Math.max(leftIdentifiers.length, rightIdentifiers.length);

	for (let index = 0; index < length; index += 1) {
		const left = leftIdentifiers[index];
		const right = rightIdentifiers[index];
		if (left === right) continue;
		if (left === undefined) return -1;
		if (right === undefined) return 1;

		const leftIsNumeric = /^\d+$/.test(left);
		const rightIsNumeric = /^\d+$/.test(right);
		if (leftIsNumeric && rightIsNumeric) {
			const leftNumber = left.replace(/^0+(?=\d)/, "");
			const rightNumber = right.replace(/^0+(?=\d)/, "");
			if (leftNumber.length !== rightNumber.length) return leftNumber.length - rightNumber.length;
			const comparison = leftNumber.localeCompare(rightNumber);
			if (comparison !== 0) return comparison;
			continue;
		}
		if (leftIsNumeric) return -1;
		if (rightIsNumeric) return 1;
		return left.localeCompare(right);
	}

	return 0;
}

function parsePackageVersion(version: string): ParsedVersion | undefined {
	const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/);
	if (!match) {
		return undefined;
	}
	return {
		major: Number.parseInt(match[1], 10),
		minor: Number.parseInt(match[2], 10),
		patch: Number.parseInt(match[3], 10),
		prerelease: match[4],
	};
}

export function comparePackageVersions(leftVersion: string, rightVersion: string): number | undefined {
	const left = parsePackageVersion(leftVersion);
	const right = parsePackageVersion(rightVersion);
	if (!left || !right) {
		return undefined;
	}

	if (left.major !== right.major) return left.major - right.major;
	if (left.minor !== right.minor) return left.minor - right.minor;
	if (left.patch !== right.patch) return left.patch - right.patch;
	if (left.prerelease === right.prerelease) return 0;
	if (!left.prerelease) return 1;
	if (!right.prerelease) return -1;
	return comparePrereleaseIdentifiers(left.prerelease, right.prerelease);
}

export function isNewerPackageVersion(candidateVersion: string, currentVersion: string): boolean {
	const comparison = comparePackageVersions(candidateVersion, currentVersion);
	if (comparison !== undefined) {
		return comparison > 0;
	}
	return candidateVersion.trim() !== currentVersion.trim();
}

function normalizeReleaseVersion(version: string): string {
	return version.trim().replace(/^v/, "");
}

function getReleaseManifestPath(currentVersion: string): string {
	const prerelease = parsePackageVersion(currentVersion)?.prerelease;
	return prerelease?.match(/^beta(?:\.|$)/) ? BETA_VERSION_MANIFEST_PATH : STABLE_VERSION_MANIFEST_PATH;
}

function getReleaseChannel(currentVersion: string): "stable" | "beta" {
	return parsePackageVersion(currentVersion)?.prerelease?.match(/^beta(?:\.|$)/) ? "beta" : "stable";
}

export function isTrustedReleaseUrl(value: string | URL): boolean {
	let url: URL;
	try {
		url = typeof value === "string" ? new URL(value) : value;
	} catch {
		return false;
	}
	if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) {
		return false;
	}
	if (url.hostname === "github.com") {
		return url.pathname.startsWith(RELEASE_REPOSITORY_PATH);
	}
	return TRUSTED_RELEASE_ASSET_HOSTS.has(url.hostname) && url.pathname.startsWith("/");
}

function assertTrustedReleaseUrl(value: string | URL): URL {
	const url = typeof value === "string" ? new URL(value) : value;
	if (!isTrustedReleaseUrl(url)) {
		throw new Error(`Untrusted PiLoom release URL: ${url.toString()}`);
	}
	return url;
}

async function fetchTrustedReleaseAsset(url: string, init: RequestInit): Promise<Response> {
	let currentUrl = assertTrustedReleaseUrl(url);
	for (let redirectCount = 0; ; redirectCount += 1) {
		const response = await fetch(currentUrl.toString(), { ...init, redirect: "manual" });
		if (response.status < 300 || response.status >= 400) {
			return response;
		}
		if (redirectCount >= MAX_RELEASE_REDIRECTS) {
			throw new Error("Too many redirects while downloading a PiLoom release asset.");
		}
		const location = response.headers.get("location");
		if (!location) {
			throw new Error("PiLoom release redirect did not include a Location header.");
		}
		currentUrl = assertTrustedReleaseUrl(new URL(location, currentUrl));
	}
}

function parseReleaseSignature(value: string, expected: { channel: "stable" | "beta"; version: string }): Buffer {
	if (value.length > 16_384) {
		throw new Error("Release signature envelope is too large.");
	}
	let envelope: Record<string, unknown>;
	try {
		envelope = JSON.parse(value) as Record<string, unknown>;
	} catch {
		throw new Error("Release signature is not valid JSON.");
	}
	const expectedFields = ["algorithm", "channel", "keyId", "releaseVersion", "signature", "version"];
	const actualFields = Object.keys(envelope).sort();
	if (
		actualFields.length !== expectedFields.length ||
		actualFields.some((field, index) => field !== expectedFields[index])
	) {
		throw new Error("Release signature envelope has unexpected fields.");
	}
	if (
		envelope.version !== 1 ||
		envelope.keyId !== RELEASE_SIGNATURE_KEY_ID ||
		envelope.algorithm !== RELEASE_SIGNATURE_ALGORITHM ||
		envelope.channel !== expected.channel ||
		envelope.releaseVersion !== expected.version ||
		typeof envelope.signature !== "string"
	) {
		throw new Error("Release signature context does not match the requested release.");
	}
	const signature = envelope.signature;
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signature) || Buffer.from(signature, "base64").toString("base64") !== signature) {
		throw new Error("Release signature is not canonical base64.");
	}
	return Buffer.from(signature, "base64");
}

export function verifyReleaseChecksumSignature(
	checksumBytes: Uint8Array,
	signatureText: string,
	expected: { channel: "stable" | "beta"; version: string },
): boolean {
	const signature = parseReleaseSignature(signatureText, expected);
	const verifier = createVerify(RELEASE_SIGNATURE_ALGORITHM);
	verifier.update(
		Buffer.concat([
			Buffer.from(`${RELEASE_SIGNATURE_CONTEXT}\0${expected.channel}\0${expected.version}\0`, "utf8"),
			Buffer.from(checksumBytes),
		]),
	);
	verifier.end();
	return verifier.verify(createPublicKey({ key: RELEASE_SIGNING_PUBLIC_JWK, format: "jwk" }), signature);
}

function assertReleaseAssetContext(url: URL, release: LatestPiRelease): string {
	const expectedTag = release.channel === "beta" ? "beta" : `v${release.version}`;
	const prefix = `${RELEASE_REPOSITORY_PATH.replace(/\/$/, "")}/download/${expectedTag}/`;
	if (url.hostname !== "github.com" || !url.pathname.startsWith(prefix)) {
		throw new Error("Release tarball URL does not match its signed channel and version.");
	}
	const fileName = basename(url.pathname);
	const expectedFileName = `${PRIME_AGENT_RELEASE_PACKAGE_NAME}-${release.version}.tgz`;
	if (fileName !== expectedFileName) {
		throw new Error(`Release manifest did not provide the expected ${expectedFileName} tarball.`);
	}
	return fileName;
}

function expectedChecksum(checksumBytes: Uint8Array, fileName: string): string {
	const matches = Buffer.from(checksumBytes)
		.toString("utf8")
		.split(/\r?\n/)
		.filter((line) => line.trim().endsWith(`  ${fileName}`) || line.trim().endsWith(` *${fileName}`));
	if (matches.length !== 1) {
		throw new Error(`Release checksums do not contain exactly one entry for ${fileName}.`);
	}
	const match = matches[0]?.trim().match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
	if (!match || match[2] !== fileName) {
		throw new Error(`Release checksum entry for ${fileName} is malformed.`);
	}
	return match[1].toLowerCase();
}

export async function downloadVerifiedReleaseTarball(
	release: LatestPiRelease,
	destinationPath: string,
	options: { signal?: AbortSignal } = {},
): Promise<void> {
	if (!release.installSpec) throw new Error("Release manifest did not provide an install tarball.");
	const tarballUri = assertTrustedReleaseUrl(release.installSpec);
	const fileName = assertReleaseAssetContext(tarballUri, release);
	const checksumUrl = new URL("SHA256SUMS", tarballUri).toString();
	const signatureUrl = new URL("SHA256SUMS.sig", tarballUri).toString();
	const request = { signal: options.signal };
	const [checksumResponse, signatureResponse] = await Promise.all([
		fetchTrustedReleaseAsset(checksumUrl, request),
		fetchTrustedReleaseAsset(signatureUrl, request),
	]);
	if (!checksumResponse.ok || !signatureResponse.ok) {
		throw new Error("PiLoom signed release metadata is unavailable.");
	}
	const checksumBytes = new Uint8Array(await checksumResponse.arrayBuffer());
	const signatureText = await signatureResponse.text();
	if (
		!verifyReleaseChecksumSignature(checksumBytes, signatureText, {
			channel: release.channel,
			version: release.version,
		})
	) {
		throw new Error("PiLoom release checksum signature verification failed.");
	}
	const tarballResponse = await fetchTrustedReleaseAsset(tarballUri.toString(), request);
	if (!tarballResponse.ok) {
		throw new Error("PiLoom release tarball is unavailable.");
	}
	const tarballBytes = new Uint8Array(await tarballResponse.arrayBuffer());
	const expected = expectedChecksum(checksumBytes, fileName);
	const actual = createHash("sha256").update(tarballBytes).digest("hex");
	if (actual !== expected) throw new Error("PiLoom release tarball checksum verification failed.");
	await mkdir(dirname(destinationPath), { recursive: true, mode: 0o700 });
	await writeFile(destinationPath, tarballBytes, { flag: "wx", mode: 0o600 });
}

function resolveReleaseUrl(pathOrUrl: string): string | undefined {
	const trimmed = pathOrUrl.trim();
	if (!trimmed) return undefined;
	try {
		const url = new URL(trimmed, `${PRIME_AGENT_RELEASE_BASE_URL}/`);
		return isTrustedReleaseUrl(url) ? url.toString() : undefined;
	} catch {
		return undefined;
	}
}

export async function getLatestPiRelease(
	currentVersion: string,
	options: { timeoutMs?: number } = {},
): Promise<LatestPiRelease | undefined> {
	if (process.env.PI_SKIP_VERSION_CHECK || process.env.PI_OFFLINE) return undefined;

	const response = await fetchTrustedReleaseAsset(
		`${PRIME_AGENT_RELEASE_BASE_URL}/${getReleaseManifestPath(currentVersion)}`,
		{
			headers: {
				"User-Agent": getPiUserAgent(currentVersion),
				accept: "application/json",
			},
			signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_VERSION_CHECK_TIMEOUT_MS),
		},
	);
	if (!response.ok) return undefined;

	const data = (await response.json()) as {
		package?: unknown;
		packageName?: unknown;
		tarball?: unknown;
		version?: unknown;
	};
	if (typeof data.version !== "string" || !data.version.trim()) {
		return undefined;
	}
	const releaseVersion = normalizeReleaseVersion(data.version);
	const releaseChannel = getReleaseChannel(currentVersion);
	const parsedReleaseVersion = parsePackageVersion(releaseVersion);
	if (!parsedReleaseVersion) return undefined;
	if (
		releaseChannel === "stable"
			? parsedReleaseVersion.prerelease
			: !parsedReleaseVersion.prerelease?.match(/^beta(?:\.|$)/)
	) {
		return undefined;
	}
	const packageName =
		typeof data.package === "string" && data.package.trim()
			? data.package.trim()
			: typeof data.packageName === "string" && data.packageName.trim()
				? data.packageName.trim()
				: PRIME_AGENT_RELEASE_PACKAGE_NAME;
	if (packageName !== PRIME_AGENT_RELEASE_PACKAGE_NAME) return undefined;
	const installSpec = typeof data.tarball === "string" ? resolveReleaseUrl(data.tarball) : undefined;
	const release: LatestPiRelease = {
		version: releaseVersion,
		channel: releaseChannel,
		packageName,
	};
	if (installSpec) {
		release.installSpec = installSpec;
	}
	return release;
}

export async function getLatestPiVersion(
	currentVersion: string,
	options: { timeoutMs?: number } = {},
): Promise<string | undefined> {
	return (await getLatestPiRelease(currentVersion, options))?.version;
}

export async function checkForNewPiVersion(currentVersion: string): Promise<string | undefined> {
	try {
		const latestVersion = await getLatestPiVersion(currentVersion);
		if (latestVersion && isNewerPackageVersion(latestVersion, currentVersion)) {
			return latestVersion;
		}
		return undefined;
	} catch {
		return undefined;
	}
}
