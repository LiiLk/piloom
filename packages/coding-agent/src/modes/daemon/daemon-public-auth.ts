import { timingSafeEqual } from "node:crypto";

export interface DaemonPublicAuthenticationResult {
	authenticated: boolean;
	id?: string;
}

export function verifyDaemonPublicAuthentication(
	line: string,
	expectedToken: string | undefined,
): DaemonPublicAuthenticationResult {
	let id: string | undefined;
	let receivedToken: string | undefined;
	try {
		const parsed = JSON.parse(line) as unknown;
		if (parsed && typeof parsed === "object") {
			const request = parsed as { id?: unknown; type?: unknown; token?: unknown };
			id = typeof request.id === "string" ? request.id : undefined;
			if (request.type === "daemon_auth" && typeof request.token === "string") {
				receivedToken = request.token;
			}
		}
	} catch {
		return { authenticated: false };
	}

	const expectedBytes = expectedToken ? Buffer.from(expectedToken, "utf8") : undefined;
	const receivedBytes = receivedToken ? Buffer.from(receivedToken, "utf8") : undefined;
	return {
		authenticated:
			expectedBytes !== undefined &&
			receivedBytes !== undefined &&
			expectedBytes.byteLength === receivedBytes.byteLength &&
			timingSafeEqual(expectedBytes, receivedBytes),
		...(id ? { id } : {}),
	};
}
