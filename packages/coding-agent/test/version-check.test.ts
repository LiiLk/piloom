import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	checkForNewPiVersion,
	comparePackageVersions,
	downloadVerifiedReleaseTarball,
	getLatestPiRelease,
	getLatestPiVersion,
	isNewerPackageVersion,
	isTrustedReleaseUrl,
	verifyReleaseChecksumSignature,
} from "../src/utils/version-check.js";

const defaultPrimeAgentReleaseBaseUrl = "https://github.com/LiiLk/piloom";
const originalSkipVersionCheck = process.env.PI_SKIP_VERSION_CHECK;
const originalOffline = process.env.PI_OFFLINE;

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[name];
		return;
	}
	process.env[name] = value;
}

afterEach(() => {
	vi.unstubAllGlobals();
	restoreEnv("PI_SKIP_VERSION_CHECK", originalSkipVersionCheck);
	restoreEnv("PI_OFFLINE", originalOffline);
});

describe("version checks", () => {
	it("compares package versions", () => {
		expect(comparePackageVersions("0.70.6", "0.70.5")).toBeGreaterThan(0);
		expect(comparePackageVersions("0.70.5", "0.70.5")).toBe(0);
		expect(comparePackageVersions("0.70.4", "0.70.5")).toBeLessThan(0);
		expect(comparePackageVersions("0.70.5-beta.10.1.abcdef0", "0.70.5-beta.9.1.1234567")).toBeGreaterThan(0);
		expect(isNewerPackageVersion("0.70.5", "0.70.5")).toBe(false);
		expect(isNewerPackageVersion("0.70.6", "0.70.5")).toBe(true);
	});

	it("returns only newer versions", async () => {
		const fetchMock = vi.fn(async () => Response.json({ version: "v1.2.3" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewPiVersion("1.2.3")).resolves.toBeUndefined();
		await expect(checkForNewPiVersion("1.2.2")).resolves.toBe("1.2.3");
	});

	it("uses the Prime Agent release manifest with a Prime Agent user agent", async () => {
		const fetchMock = vi.fn(async () => Response.json({ version: "v1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiVersion("1.2.3")).resolves.toBe("1.2.4");
		expect(fetchMock).toHaveBeenCalledWith(
			`${defaultPrimeAgentReleaseBaseUrl}/releases/latest/download/latest.json`,
			expect.objectContaining({
				redirect: "manual",
				headers: expect.objectContaining({
					"User-Agent": expect.stringMatching(/^prime-agent\/1\.2\.3 /),
					accept: "application/json",
				}),
			}),
		);
	});

	it("keeps beta installations on the beta release manifest", async () => {
		const fetchMock = vi.fn(async () => Response.json({ version: "v1.2.4-beta.124.1.abcdef0" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiVersion("1.2.4-beta.123.1.1234567")).resolves.toBe("1.2.4-beta.124.1.abcdef0");
		expect(fetchMock).toHaveBeenCalledWith(
			`${defaultPrimeAgentReleaseBaseUrl}/releases/download/beta/beta.json`,
			expect.objectContaining({ redirect: "manual" }),
		);
	});

	it("returns the active package and tarball install spec from the release manifest", async () => {
		const fetchMock = vi.fn(async () =>
			Response.json({
				package: "prime-agent",
				tarball: "releases/download/v1.2.4/prime-agent-1.2.4.tgz",
				version: "v1.2.4",
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiRelease("1.2.3")).resolves.toEqual({
			channel: "stable",
			installSpec: `${defaultPrimeAgentReleaseBaseUrl}/releases/download/v1.2.4/prime-agent-1.2.4.tgz`,
			packageName: "prime-agent",
			version: "1.2.4",
		});
	});

	it("verifies the embedded release signature and rejects substituted context", () => {
		const checksumBytes = readFileSync("../../scripts/fixtures/release-signing/SHA256SUMS");
		const signature = readFileSync("../../scripts/fixtures/release-signing/SHA256SUMS.sig", "utf8");
		expect(verifyReleaseChecksumSignature(checksumBytes, signature, { channel: "stable", version: "0.0.0" })).toBe(
			true,
		);
		expect(() =>
			verifyReleaseChecksumSignature(checksumBytes, signature, { channel: "beta", version: "0.0.0" }),
		).toThrow("context");
		expect(
			verifyReleaseChecksumSignature(Buffer.from(`${checksumBytes}tampered`), signature, {
				channel: "stable",
				version: "0.0.0",
			}),
		).toBe(false);
	});

	it("authenticates signed metadata before downloading the self-update tarball", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response(`${"a".repeat(64)}  prime-agent-1.2.4.tgz\n`))
			.mockResolvedValueOnce(new Response("not a signature"));
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			downloadVerifiedReleaseTarball(
				{
					channel: "stable",
					installSpec: `${defaultPrimeAgentReleaseBaseUrl}/releases/download/v1.2.4/prime-agent-1.2.4.tgz`,
					packageName: "prime-agent",
					version: "1.2.4",
				},
				"unused.tgz",
			),
		).rejects.toThrow("signature");
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fetchMock.mock.calls.every(([url]) => !String(url).endsWith("prime-agent-1.2.4.tgz"))).toBe(true);
	});

	it("rejects a manifest tarball name that does not match the signed PiLoom package", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			downloadVerifiedReleaseTarball(
				{
					channel: "stable",
					installSpec: `${defaultPrimeAgentReleaseBaseUrl}/releases/download/v1.2.4/other-1.2.4.tgz`,
					packageName: "prime-agent",
					version: "1.2.4",
				},
				"unused.tgz",
			),
		).rejects.toThrow("expected prime-agent-1.2.4.tgz");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("follows only GitHub HTTPS release redirects", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(null, {
					status: 302,
					headers: {
						location: "https://release-assets.githubusercontent.com/github-production-release-asset/example",
					},
				}),
			)
			.mockResolvedValueOnce(Response.json({ version: "v1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiVersion("1.2.3")).resolves.toBe("1.2.4");
		expect(fetchMock).toHaveBeenNthCalledWith(
			1,
			`${defaultPrimeAgentReleaseBaseUrl}/releases/latest/download/latest.json`,
			expect.objectContaining({ redirect: "manual" }),
		);
		expect(fetchMock).toHaveBeenNthCalledWith(
			2,
			"https://release-assets.githubusercontent.com/github-production-release-asset/example",
			expect.objectContaining({ redirect: "manual" }),
		);
	});

	it("rejects untrusted or downgraded release redirects", async () => {
		expect(isTrustedReleaseUrl("https://github.com/LiiLk/piloom/releases/download/v1.2.3/file")).toBe(true);
		expect(
			isTrustedReleaseUrl("https://release-assets.githubusercontent.com/github-production-release-asset/example"),
		).toBe(true);
		expect(isTrustedReleaseUrl("https://evil.example/releases/download/v1.2.3/file")).toBe(false);
		expect(isTrustedReleaseUrl("http://github.com/LiiLk/piloom/releases/download/v1.2.3/file")).toBe(false);
		expect(isTrustedReleaseUrl("https://user@github.com/LiiLk/piloom/releases/download/v1.2.3/file")).toBe(false);

		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(null, { status: 302, headers: { location: "http://evil.example/file" } })),
		);
		await expect(getLatestPiVersion("1.2.3")).rejects.toThrow("Untrusted PiLoom release URL");
	});

	it("skips api calls when version checks are disabled", async () => {
		process.env.PI_SKIP_VERSION_CHECK = "1";
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiVersion("1.2.3")).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
