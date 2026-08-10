#!/usr/bin/env node

import { createPublicKey, createSign, createVerify } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RELEASE_SIGNATURE_ALGORITHM = "RSA-SHA256";
export const RELEASE_SIGNATURE_KEY_ID = "piloom-release-2026-08";
export const RELEASE_SIGNING_PUBLIC_JWK = Object.freeze({
	kty: "RSA",
	n: "xVa8-RGteyJqLVxbCg6Grp3awVN1ROmGWLpnQr2FUuAnq6WO-vY5jHABxpFhBZZDdzLmfJuy9LYikL8hLpHvuL8ip9LWHHhE6-AkDjdVYW0x5AWezdKHhf-1qxtwMeGxBJFwhbrMlwZL6qM140c_aH-RRivHWmRhUTignNhvn_AJiuZmm23yDK3FqqEC7QEnXabyreg4cPMfxHHMyklkowTHOz3gcSnxSj2cYgC9EFNtWqJZHk0deT77ZmaZ5De7pAEkQnqrn7zmQCc2k9-Rgg1jiAd7re6iH1RFNwmNysgaVGQz9lIKzAw3AslJKyunmrlvAXI8UMJBdDoU2YGtZ6HiLWyKrapw--ozFHGuJvgQWDQxfKQrTu9-Nc7cvkPblEu1jNV_dYPHINAoVkJboChkEA16Mz05yYL2alrEZ9SHBrY8nbqR8Tnw7Go8kY5dV_3QsdfxT_Ny89aI9whaTWsHWwCfREWoCkirgRdV0WGXMTRJ28ap9qdJcMa5Regb",
	e: "AQAB",
});
const SIGNATURE_FIELDS = ["algorithm", "channel", "keyId", "releaseVersion", "signature", "version"];
const RELEASE_CHANNELS = new Set(["stable", "beta"]);
const SIGNATURE_CONTEXT = "piloom-release-signature-v1";

function parseBase64(value) {
	if (typeof value !== "string" || value.length === 0 || value.length > 16_384 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
		throw new Error("Release signature is not valid base64");
	}
	const decoded = Buffer.from(value, "base64");
	if (decoded.toString("base64") !== value) {
		throw new Error("Release signature is not canonical base64");
	}
	return decoded;
}

function validateReleaseContext(channel, releaseVersion) {
	if (!RELEASE_CHANNELS.has(channel)) throw new Error(`Unsupported release channel: ${channel}`);
	if (typeof releaseVersion !== "string" || !/^[0-9A-Za-z.-]+$/.test(releaseVersion)) {
		throw new Error(`Invalid release version: ${releaseVersion}`);
	}
}

function signaturePayload(checksumBytes, channel, releaseVersion) {
	validateReleaseContext(channel, releaseVersion);
	return Buffer.concat([Buffer.from(`${SIGNATURE_CONTEXT}\0${channel}\0${releaseVersion}\0`, "utf8"), checksumBytes]);
}

export function parseSignatureEnvelope(value, expected) {
	const envelope = typeof value === "string" ? JSON.parse(value) : value;
	if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
		throw new Error("Release signature envelope must be an object");
	}
	const fields = Object.keys(envelope).sort();
	if (fields.length !== SIGNATURE_FIELDS.length || fields.some((field, index) => field !== SIGNATURE_FIELDS[index])) {
		throw new Error("Release signature envelope has unexpected fields");
	}
	if (envelope.version !== 1) {
		throw new Error(`Unsupported release signature version: ${envelope.version}`);
	}
	if (envelope.keyId !== (expected.keyId ?? RELEASE_SIGNATURE_KEY_ID)) {
		throw new Error(`Unexpected release signing key: ${envelope.keyId}`);
	}
	if (envelope.algorithm !== RELEASE_SIGNATURE_ALGORITHM) {
		throw new Error(`Unsupported release signature algorithm: ${envelope.algorithm}`);
	}
	validateReleaseContext(envelope.channel, envelope.releaseVersion);
	if (envelope.channel !== expected.channel) throw new Error(`Unexpected release channel: ${envelope.channel}`);
	if (envelope.releaseVersion !== expected.releaseVersion) {
		throw new Error(`Unexpected signed release version: ${envelope.releaseVersion}`);
	}
	return {
		...envelope,
		signatureBytes: parseBase64(envelope.signature),
	};
}

export function createSignatureEnvelope(checksumBytes, privateKey, options) {
	const keyId = options.keyId ?? RELEASE_SIGNATURE_KEY_ID;
	const payload = signaturePayload(checksumBytes, options.channel, options.releaseVersion);
	const signer = createSign(RELEASE_SIGNATURE_ALGORITHM);
	signer.update(payload);
	signer.end();
	return {
		version: 1,
		keyId,
		algorithm: RELEASE_SIGNATURE_ALGORITHM,
		channel: options.channel,
		releaseVersion: options.releaseVersion,
		signature: signer.sign(privateKey).toString("base64"),
	};
}

export function verifySignatureEnvelope(checksumBytes, envelopeValue, publicKey, expected) {
	const envelope = parseSignatureEnvelope(envelopeValue, expected);
	const verifier = createVerify(RELEASE_SIGNATURE_ALGORITHM);
	verifier.update(signaturePayload(checksumBytes, envelope.channel, envelope.releaseVersion));
	verifier.end();
	return verifier.verify(publicKey, envelope.signatureBytes);
}

export function assertSigningKey(privateKey, expectedPublicJwk = RELEASE_SIGNING_PUBLIC_JWK) {
	const publicKey = createPublicKey(privateKey);
	const actualPublicJwk = publicKey.export({ format: "jwk" });
	if (actualPublicJwk.kty !== "RSA" || actualPublicJwk.n !== expectedPublicJwk.n || actualPublicJwk.e !== expectedPublicJwk.e) {
		throw new Error(`Release signing private key does not match ${RELEASE_SIGNATURE_KEY_ID}`);
	}
	return publicKey;
}

export function signChecksumFiles(checksumPaths, privateKey, options) {
	const expected = { channel: options.channel, releaseVersion: options.releaseVersion };
	const publicKey = assertSigningKey(privateKey, options.expectedPublicJwk ?? RELEASE_SIGNING_PUBLIC_JWK);
	for (const checksumPath of checksumPaths.map((path) => resolve(path))) {
		const checksumBytes = readFileSync(checksumPath);
		const envelope = createSignatureEnvelope(checksumBytes, privateKey, expected);
		if (!verifySignatureEnvelope(checksumBytes, envelope, publicKey, expected)) {
			throw new Error(`Generated signature did not verify for ${checksumPath}`);
		}
		const signaturePath = `${checksumPath}.sig`;
		writeFileSync(signaturePath, `${JSON.stringify(envelope)}\n`, { mode: 0o644 });
		console.log(`Signed ${checksumPath} -> ${signaturePath} (${RELEASE_SIGNATURE_KEY_ID})`);
	}
}

function main() {
	const args = process.argv.slice(2);
	let channel;
	let releaseVersion;
	const checksumPaths = [];
	for (let index = 0; index < args.length; index += 1) {
		const value = args[index];
		if (value === "--channel" || value === "--version") {
			const optionValue = args[index + 1];
			if (!optionValue || optionValue.startsWith("--")) throw new Error(`Missing value for ${value}`);
			if (value === "--channel") {
				if (channel !== undefined) throw new Error("--channel may only be specified once");
				channel = optionValue;
			} else {
				if (releaseVersion !== undefined) throw new Error("--version may only be specified once");
				releaseVersion = optionValue;
			}
			index += 1;
		} else {
			checksumPaths.push(value);
		}
	}
	if (!channel || !releaseVersion || checksumPaths.length === 0) {
		throw new Error(
			"Usage: node scripts/sign-release-checksums.mjs --channel stable|beta --version <version> <checksum-file> [...]",
		);
	}
	const privateKey = process.env.PILOOM_RELEASE_SIGNING_PRIVATE_KEY;
	if (!privateKey) {
		throw new Error("PILOOM_RELEASE_SIGNING_PRIVATE_KEY is required");
	}
	signChecksumFiles(checksumPaths, privateKey, { channel, releaseVersion });
}

const entryPoint = process.argv[1] ? resolve(process.argv[1]) : "";
if (entryPoint === fileURLToPath(import.meta.url)) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
