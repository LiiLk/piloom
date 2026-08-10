import { createHmac, timingSafeEqual } from "node:crypto";

const CLIENT_PROOF_CONTEXT = "piloom-daemon-auth:client";
const SERVER_PROOF_CONTEXT = "piloom-daemon-auth:server";

export interface DaemonPublicAuthenticationResult {
	authenticated: boolean;
	id?: string;
	serverProof?: string;
}

function createAuthenticationProof(token: string, context: string, nonce: string): string {
	return createHmac("sha256", token).update(context).update("\0").update(nonce).digest("base64url");
}

export function createDaemonClientAuthenticationProof(token: string, nonce: string): string {
	return createAuthenticationProof(token, CLIENT_PROOF_CONTEXT, nonce);
}

export function createDaemonServerAuthenticationProof(token: string, nonce: string): string {
	return createAuthenticationProof(token, SERVER_PROOF_CONTEXT, nonce);
}

export function verifyDaemonServerAuthenticationProof(token: string, nonce: string, proof: string): boolean {
	return equalProofs(createDaemonServerAuthenticationProof(token, nonce), proof);
}

function equalProofs(expected: string, received: string): boolean {
	const expectedBytes = Buffer.from(expected, "utf8");
	const receivedBytes = Buffer.from(received, "utf8");
	return expectedBytes.byteLength === receivedBytes.byteLength && timingSafeEqual(expectedBytes, receivedBytes);
}

export function verifyDaemonPublicAuthentication(
	line: string,
	expectedToken: string | undefined,
): DaemonPublicAuthenticationResult {
	let id: string | undefined;
	let nonce: string | undefined;
	let receivedProof: string | undefined;
	try {
		const parsed = JSON.parse(line) as unknown;
		if (parsed && typeof parsed === "object") {
			const request = parsed as { id?: unknown; nonce?: unknown; proof?: unknown; type?: unknown };
			id = typeof request.id === "string" ? request.id : undefined;
			if (
				request.type === "daemon_auth" &&
				typeof request.nonce === "string" &&
				request.nonce.length >= 32 &&
				request.nonce.length <= 128 &&
				typeof request.proof === "string" &&
				request.proof.length <= 128
			) {
				nonce = request.nonce;
				receivedProof = request.proof;
			}
		}
	} catch {
		return { authenticated: false };
	}

	const expectedProof =
		expectedToken && nonce ? createDaemonClientAuthenticationProof(expectedToken, nonce) : undefined;
	const authenticated =
		expectedProof !== undefined && receivedProof !== undefined && equalProofs(expectedProof, receivedProof);
	return {
		authenticated,
		...(id ? { id } : {}),
		...(authenticated && expectedToken && nonce
			? { serverProof: createDaemonServerAuthenticationProof(expectedToken, nonce) }
			: {}),
	};
}
