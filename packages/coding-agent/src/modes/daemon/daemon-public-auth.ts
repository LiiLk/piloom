import { createHmac, timingSafeEqual } from "node:crypto";

const CLIENT_PROOF_CONTEXT = "piloom-daemon-auth:client";
const SERVER_PROOF_CONTEXT = "piloom-daemon-auth:server";

export interface DaemonPublicAuthenticationResult {
	authenticated: boolean;
	id?: string;
	clientId?: string;
	serverProof?: string;
}

function createAuthenticationProof(token: string, context: string, challenge: string, clientId: string): string {
	return createHmac("sha256", token)
		.update(context)
		.update("\0")
		.update(challenge)
		.update("\0")
		.update(clientId)
		.digest("base64url");
}

export function createDaemonClientAuthenticationProof(token: string, challenge: string, clientId: string): string {
	return createAuthenticationProof(token, CLIENT_PROOF_CONTEXT, challenge, clientId);
}

export function createDaemonServerAuthenticationProof(token: string, challenge: string, clientId: string): string {
	return createAuthenticationProof(token, SERVER_PROOF_CONTEXT, challenge, clientId);
}

export function verifyDaemonServerAuthenticationProof(
	token: string,
	challenge: string,
	clientId: string,
	proof: string,
): boolean {
	return equalProofs(createDaemonServerAuthenticationProof(token, challenge, clientId), proof);
}

function equalProofs(expected: string, received: string): boolean {
	const expectedBytes = Buffer.from(expected, "utf8");
	const receivedBytes = Buffer.from(received, "utf8");
	return expectedBytes.byteLength === receivedBytes.byteLength && timingSafeEqual(expectedBytes, receivedBytes);
}

export function verifyDaemonPublicAuthentication(
	line: string,
	expectedToken: string | undefined,
	expectedChallenge: string | undefined,
): DaemonPublicAuthenticationResult {
	let id: string | undefined;
	let challenge: string | undefined;
	let clientId: string | undefined;
	let receivedProof: string | undefined;
	try {
		const parsed = JSON.parse(line) as unknown;
		if (parsed && typeof parsed === "object") {
			const request = parsed as {
				challenge?: unknown;
				clientId?: unknown;
				id?: unknown;
				proof?: unknown;
				type?: unknown;
			};
			id = typeof request.id === "string" ? request.id : undefined;
			if (
				request.type === "daemon_auth" &&
				typeof request.challenge === "string" &&
				request.challenge.length >= 32 &&
				request.challenge.length <= 128 &&
				typeof request.clientId === "string" &&
				request.clientId.length >= 1 &&
				request.clientId.length <= 256 &&
				typeof request.proof === "string" &&
				request.proof.length <= 128
			) {
				challenge = request.challenge;
				clientId = request.clientId;
				receivedProof = request.proof;
			}
		}
	} catch {
		return { authenticated: false };
	}

	const expectedProof =
		expectedToken && expectedChallenge && challenge === expectedChallenge && clientId
			? createDaemonClientAuthenticationProof(expectedToken, expectedChallenge, clientId)
			: undefined;
	const authenticated =
		expectedProof !== undefined && receivedProof !== undefined && equalProofs(expectedProof, receivedProof);
	return {
		authenticated,
		...(id ? { id } : {}),
		...(authenticated && clientId ? { clientId } : {}),
		...(authenticated && expectedToken && expectedChallenge && clientId
			? { serverProof: createDaemonServerAuthenticationProof(expectedToken, expectedChallenge, clientId) }
			: {}),
	};
}
