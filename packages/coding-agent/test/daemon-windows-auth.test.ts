import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonClient } from "../src/modes/daemon/daemon-client.js";
import {
	createDaemonCommandEnvelope,
	DAEMON_DEFAULT_SERVER_CAPABILITIES,
	DAEMON_PROTOCOL_INFO,
	DAEMON_SCHEMA_ID,
	DAEMON_SCHEMA_REVISION,
	getDaemonSupervisorServerCapabilities,
	success,
} from "../src/modes/daemon/daemon-protocol.js";
import { verifyDaemonPublicAuthentication } from "../src/modes/daemon/daemon-public-auth.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
import {
	acquireDaemonSupervisorOwnership,
	readDaemonSupervisorAuthenticationToken,
} from "../src/modes/daemon/daemon-supervisor-ownership.js";
import { serializeJsonLine } from "../src/modes/rpc/jsonl.js";

const REGISTRY_ENV = "PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR";

describe.skipIf(process.platform !== "win32")("Windows daemon authentication", () => {
	const cleanup: Array<() => void | Promise<void>> = [];

	afterEach(async () => {
		for (const dispose of cleanup.splice(0).reverse()) {
			await dispose();
		}
		delete process.env[REGISTRY_ENV];
	});

	it("protects the public pipe token with current-user DPAPI and rejects an old unauthenticated client", async () => {
		const registryDir = createTempDirectory();
		cleanup.push(() => rmSync(registryDir, { recursive: true, force: true }));
		const socketPath = createPipePath();
		const generation = `auth-${randomUUID()}`;
		const ownership = await acquireDaemonSupervisorOwnership({
			socketPath,
			descriptorDir: join(registryDir, "descriptors"),
			agentDir: join(registryDir, "agents"),
			generation,
			appVersion: "test",
			registryDir,
		});
		cleanup.push(() => ownership.release());

		const recovered = readDaemonSupervisorAuthenticationToken(socketPath, generation, registryDir);
		expect(recovered).toBe(ownership.authenticationToken);
		expect(recovered).toBeTruthy();
		expect(
			verifyDaemonPublicAuthentication(
				JSON.stringify({ id: "auth", type: "daemon_auth", token: recovered }),
				recovered,
			),
		).toEqual({
			authenticated: true,
			id: "auth",
		});
		expect(
			verifyDaemonPublicAuthentication(
				JSON.stringify({
					type: "command",
					id: "old-client",
					protocol: { name: "prime-agent.daemon", version: 7 },
					command: { type: "list" },
				}),
				recovered,
			),
		).toEqual({ authenticated: false, id: "old-client" });
	});

	it("rejects an old client on the real public supervisor before command admission", async () => {
		const root = createTempDirectory();
		cleanup.push(() => rmSync(root, { recursive: true, force: true }));
		process.env[REGISTRY_ENV] = join(root, "registry");
		const socketPath = createPipePath();
		const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as unknown as typeof process.exit);
		cleanup.push(() => exit.mockRestore());
		const supervisor = new DaemonSupervisor(socketPath, {
			defaultSessionConfig: {
				cwd: root,
				agentDir: join(root, "agent"),
				noExtensions: true,
				noTools: true,
			},
		});
		await supervisor.start();
		cleanup.push(async () => {
			await shutdownSupervisor(socketPath);
			await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
		});

		const socket = createConnection(socketPath);
		cleanup.push(() => {
			socket.destroy();
		});
		const lines = createLineQueue(socket);
		const hello = await lines.next();
		expect(hello).toMatchObject({
			type: "daemon_hello",
			serverCapabilities: expect.arrayContaining(["windows_pipe_auth"]),
		});
		socket.write(serializeJsonLine(createDaemonCommandEnvelope({ type: "list" }, "old-list", "old-client", 7)));

		await expect(lines.next()).resolves.toMatchObject({
			id: "old-list",
			command: "daemon_auth",
			success: false,
		});
	});

	it("authenticates before accepting commands from a new client", async () => {
		const registryDir = createTempDirectory();
		cleanup.push(() => rmSync(registryDir, { recursive: true, force: true }));
		process.env[REGISTRY_ENV] = registryDir;
		const socketPath = createPipePath();
		const generation = `auth-${randomUUID()}`;
		const ownership = await acquireDaemonSupervisorOwnership({
			socketPath,
			descriptorDir: join(registryDir, "descriptors"),
			agentDir: join(registryDir, "agents"),
			generation,
			appVersion: "test",
			registryDir,
		});
		cleanup.push(() => ownership.release());

		const receivedTypes: string[] = [];
		const server = createServer((socket) => {
			writeHello(
				socket,
				socketPath,
				generation,
				getDaemonSupervisorServerCapabilities("win32"),
				undefined,
				ownership.record.protectedAuthenticationToken,
			);
			readJsonLines(socket, (message) => {
				const type = typeof message.type === "string" ? message.type : "unknown";
				receivedTypes.push(type);
				if (type === "daemon_auth") {
					const request = message as { id: string; token: string };
					const result = verifyDaemonPublicAuthentication(JSON.stringify(message), ownership.authenticationToken);
					expect(result.authenticated).toBe(true);
					socket.write(serializeJsonLine(success(request.id, "daemon_auth")));
					return;
				}
				const envelope = message as { id: string; command: { type: string } };
				expect(envelope.command.type).toBe("list");
				socket.write(serializeJsonLine(success(envelope.id, "list", [])));
			});
		});
		await listen(server, socketPath);
		cleanup.push(() => closeServer(server));

		const client = new DaemonClient(socketPath);
		cleanup.push(() => client.close());
		await client.connect();
		await client.waitForHello();
		const response = await client.request({ type: "list" });

		expect(response.success).toBe(true);
		expect(receivedTypes).toEqual(["daemon_auth", "command"]);
	});

	it("keeps a new client compatible with an old daemon that does not advertise authentication", async () => {
		const socketPath = createPipePath();
		const server = createServer((socket) => {
			writeHello(socket, socketPath, "legacy", DAEMON_DEFAULT_SERVER_CAPABILITIES, 7);
			readJsonLines(socket, (message) => {
				expect(message.type).toBe("command");
				const envelope = message as { id: string; protocol: { version: number }; command: { type: string } };
				expect(envelope.protocol.version).toBe(7);
				expect(envelope.command.type).toBe("list");
				socket.write(serializeJsonLine(success(envelope.id, "list", [])));
			});
		});
		await listen(server, socketPath);
		cleanup.push(() => closeServer(server));

		const client = new DaemonClient(socketPath);
		cleanup.push(() => client.close());
		await client.connect();
		await client.waitForHello();
		expect((await client.request({ type: "list" })).success).toBe(true);
	});
});

function createTempDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "piloom-daemon-auth-"));
	return directory;
}

function createPipePath(): string {
	return `\\\\.\\pipe\\piloom-auth-${randomUUID()}`;
}

function writeHello(
	socket: Socket,
	socketPath: string,
	generation: string,
	serverCapabilities: readonly string[],
	protocolVersion = DAEMON_PROTOCOL_INFO.version,
	protectedAuthenticationToken?: string,
): void {
	socket.write(
		serializeJsonLine({
			type: "daemon_hello",
			socketPath,
			protocol: { ...DAEMON_PROTOCOL_INFO, version: protocolVersion },
			schemaId: protocolVersion === DAEMON_PROTOCOL_INFO.version ? DAEMON_SCHEMA_ID : "legacy",
			schemaRevision: protocolVersion === DAEMON_PROTOCOL_INFO.version ? DAEMON_SCHEMA_REVISION : 14,
			supervisorGeneration: generation,
			...(protectedAuthenticationToken
				? { supervisorProtectedAuthenticationToken: protectedAuthenticationToken }
				: {}),
			serverCapabilities,
		}),
	);
}

function readJsonLines(socket: Socket, listener: (message: Record<string, unknown>) => void): void {
	let buffered = "";
	socket.on("data", (chunk: Buffer) => {
		buffered += chunk.toString("utf8");
		while (true) {
			const newline = buffered.indexOf("\n");
			if (newline < 0) return;
			const line = buffered.slice(0, newline);
			buffered = buffered.slice(newline + 1);
			listener(JSON.parse(line) as Record<string, unknown>);
		}
	});
}

function createLineQueue(socket: Socket): { next: () => Promise<Record<string, unknown>> } {
	const queued: Record<string, unknown>[] = [];
	const waiters: Array<(message: Record<string, unknown>) => void> = [];
	readJsonLines(socket, (message) => {
		const waiter = waiters.shift();
		if (waiter) waiter(message);
		else queued.push(message);
	});
	return {
		next: () => {
			const message = queued.shift();
			if (message) return Promise.resolve(message);
			return new Promise((resolveMessage) => waiters.push(resolveMessage));
		},
	};
}

function listen(server: Server, socketPath: string): Promise<void> {
	return new Promise((resolveListen, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => {
			server.off("error", reject);
			resolveListen();
		});
	});
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolveClose, reject) => {
		server.close((error) => (error ? reject(error) : resolveClose()));
	});
}

async function shutdownSupervisor(socketPath: string): Promise<void> {
	const client = new DaemonClient(socketPath);
	try {
		await client.connect();
		await client.waitForHello();
		await client.request({ type: "shutdown" });
	} finally {
		client.close();
	}
}
