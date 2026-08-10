import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
	RELEASE_SIGNATURE_KEY_ID,
	RELEASE_SIGNING_PUBLIC_JWK,
	createSignatureEnvelope,
	parseSignatureEnvelope,
	signChecksumFiles,
	verifySignatureEnvelope,
} from "./sign-release-checksums.mjs";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	publicKeyEncoding: { type: "spki", format: "pem" },
	privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const checksumBytes = Buffer.from(`${"a".repeat(64)}  prime-agent-0.0.0.tgz\n`, "utf8");
const expectedRelease = { channel: "stable", releaseVersion: "0.0.0" };
const envelope = createSignatureEnvelope(checksumBytes, privateKey, expectedRelease);

if (!verifySignatureEnvelope(checksumBytes, envelope, publicKey, expectedRelease)) {
	throw new Error("A valid release signature was rejected");
}
if (verifySignatureEnvelope(Buffer.concat([checksumBytes, Buffer.from("tampered")]), envelope, publicKey, expectedRelease)) {
	throw new Error("A tampered checksum manifest was accepted");
}

for (const substitutedRelease of [
	{ channel: "beta", releaseVersion: "0.0.0" },
	{ channel: "stable", releaseVersion: "0.0.1" },
]) {
	try {
		verifySignatureEnvelope(checksumBytes, envelope, publicKey, substitutedRelease);
		throw new Error("Substituted release context was accepted");
	} catch (error) {
		if (error instanceof Error && error.message === "Substituted release context was accepted") throw error;
	}
}

const malformedEnvelope = { ...envelope, signature: `${envelope.signature.slice(0, -4)}!!!!` };
try {
	parseSignatureEnvelope(malformedEnvelope, expectedRelease);
	throw new Error("A malformed release signature was accepted");
} catch (error) {
	if (error instanceof Error && error.message === "A malformed release signature was accepted") throw error;
}

const temporaryDirectory = mkdtempSync(join(tmpdir(), "piloom-release-signing-"));
try {
	const checksumPath = join(temporaryDirectory, "SHA256SUMS");
	writeFileSync(checksumPath, checksumBytes);
	const testPublicJwk = createPublicKey(publicKey).export({ format: "jwk" });
	signChecksumFiles([checksumPath], privateKey, { ...expectedRelease, expectedPublicJwk: testPublicJwk });
	const writtenEnvelope = readFileSync(`${checksumPath}.sig`, "utf8");
	if (!verifySignatureEnvelope(checksumBytes, writtenEnvelope, publicKey, expectedRelease)) {
		throw new Error("The release signing CLI wrote an invalid signature");
	}
} finally {
	rmSync(temporaryDirectory, { recursive: true, force: true });
}

function readAssignment(source, variableName) {
	const match = source.match(new RegExp(`${variableName}\\s*=\\s*["']([^"']+)["']`));
	if (!match) throw new Error(`Missing ${variableName} in installer`);
	return match[1];
}

const posixInstaller = readFileSync("install.sh", "utf8");
const powershellInstaller = readFileSync("install.ps1", "utf8");
const embeddedKeyId = readAssignment(posixInstaller, "prime_agent_release_signing_key_id");
const embeddedModulus = readAssignment(posixInstaller, "prime_agent_release_signing_modulus");
const embeddedExponent = readAssignment(posixInstaller, "prime_agent_release_signing_exponent");
if (embeddedKeyId !== RELEASE_SIGNATURE_KEY_ID) throw new Error("POSIX installer release key ID is out of sync");
if (readAssignment(powershellInstaller, "\\$releaseSigningKeyId") !== embeddedKeyId) {
	throw new Error("PowerShell and POSIX installer release key IDs differ");
}
if (readAssignment(powershellInstaller, "\\$releaseSigningModulus") !== Buffer.from(embeddedModulus, "base64url").toString("base64")) {
	throw new Error("PowerShell and POSIX installer RSA moduli differ");
}
if (readAssignment(powershellInstaller, "\\$releaseSigningExponent") !== Buffer.from(embeddedExponent, "base64url").toString("base64")) {
	throw new Error("PowerShell and POSIX installer RSA exponents differ");
}
if (RELEASE_SIGNING_PUBLIC_JWK.n !== embeddedModulus || RELEASE_SIGNING_PUBLIC_JWK.e !== embeddedExponent) {
	throw new Error("Release signer and installers embed different public keys");
}

const wrongKeyResult = spawnSync(
	process.execPath,
	[
		resolve("scripts/sign-release-checksums.mjs"),
		"--channel",
		"stable",
		"--version",
		"0.0.0",
		"scripts/fixtures/release-signing/SHA256SUMS",
	],
	{
		encoding: "utf8",
		env: { ...process.env, PILOOM_RELEASE_SIGNING_PRIVATE_KEY: privateKey },
	},
);
if (wrongKeyResult.status === 0 || !wrongKeyResult.stderr.includes("does not match")) {
	throw new Error("Release signing CLI did not reject a private key that differs from the pinned public key");
}

const fixtureChecksums = readFileSync("scripts/fixtures/release-signing/SHA256SUMS");
const fixtureEnvelope = readFileSync("scripts/fixtures/release-signing/SHA256SUMS.sig", "utf8");
const embeddedPublicKey = createPublicKey({
	key: { kty: "RSA", n: embeddedModulus, e: embeddedExponent },
	format: "jwk",
});
if (!verifySignatureEnvelope(fixtureChecksums, fixtureEnvelope, embeddedPublicKey, expectedRelease)) {
	throw new Error("Committed release signature fixture does not match the installers' embedded public key");
}

console.log("Release signing check passed (valid signature accepted; tampering and malformed base64 rejected).");
