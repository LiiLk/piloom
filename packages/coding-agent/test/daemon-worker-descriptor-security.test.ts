import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	protectWorkerDescriptorForStorage,
	unprotectWorkerDescriptorFromStorage,
} from "../src/modes/daemon/daemon-supervisor.js";
import type { DaemonWorkerDescriptor } from "../src/modes/daemon/daemon-worker-protocol.js";

function createDescriptor(): DaemonWorkerDescriptor {
	const now = new Date().toISOString();
	return {
		version: 1,
		workerId: randomUUID(),
		pid: process.pid,
		socketPath: String.raw`\\.\pipe\piloom-worker-test`,
		recoveryJournalPath: "worker.recovery.jsonl",
		supervisorSocketPath: String.raw`\\.\pipe\piloom-supervisor-test`,
		authenticationToken: randomBytes(32).toString("base64url"),
		rootActiveSessionId: randomUUID(),
		createdAt: now,
		updatedAt: now,
		lifecycle: "ready",
		createCommand: { type: "create" },
		consecutiveFailures: 0,
	};
}

describe.runIf(process.platform === "win32")("Windows worker descriptor protection", () => {
	it("persists the worker token with DPAPI and restores it for the owning user", () => {
		const descriptor = createDescriptor();
		const stored = protectWorkerDescriptorForStorage(descriptor);

		expect(stored.authenticationToken).toMatch(/^dpapi:/);
		expect(stored.authenticationToken).not.toContain(descriptor.authenticationToken);
		expect(unprotectWorkerDescriptorFromStorage(stored)).toEqual(descriptor);
	});

	it("refuses plaintext and context-swapped worker tokens", () => {
		const descriptor = createDescriptor();
		expect(() => unprotectWorkerDescriptorFromStorage(descriptor)).toThrow(/unprotected Windows worker/);

		const stored = protectWorkerDescriptorForStorage(descriptor);
		expect(() => unprotectWorkerDescriptorFromStorage({ ...stored, workerId: randomUUID() })).toThrow();
	});
});
