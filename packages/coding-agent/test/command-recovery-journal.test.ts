import fs, { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandRecoveryJournal } from "../src/modes/daemon/command-recovery-journal.js";

describe("CommandRecoveryJournal", () => {
	const roots: string[] = [];

	afterEach(() => {
		for (const root of roots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	function createPath(): string {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-command-journal-"));
		roots.push(root);
		return join(root, "commands.jsonl");
	}

	it("marks received commands uncertain instead of replaying them", () => {
		const journal = new CommandRecoveryJournal(createPath());
		expect(journal.begin("client-a", "command-a", "prompt")).toEqual({ status: "new" });
		expect(journal.begin("client-a", "command-a", "prompt")).toEqual({ status: "pending" });
	});

	it("looks up prior commands without inserting new receipts", () => {
		const journal = new CommandRecoveryJournal(createPath());
		expect(journal.lookup("client-a", "missing")).toBeUndefined();
		expect(journal.begin("client-a", "pending", "prompt")).toEqual({ status: "new" });
		expect(journal.lookup("client-a", "pending")).toEqual({ status: "pending" });
	});

	it("does not collide when client and command ids contain separators", () => {
		const journal = new CommandRecoveryJournal(createPath());
		expect(journal.begin("client:a", "command", "prompt")).toEqual({ status: "new" });
		expect(journal.begin("client", "a:command", "prompt")).toEqual({ status: "new" });
	});

	it("returns a durable stored result for a repeated idempotency key", () => {
		const path = createPath();
		const journal = new CommandRecoveryJournal(path);
		journal.begin("client-a", "command-a", "prompt");
		journal.recordResult("client-a", "command-a", {
			id: "command-a",
			type: "response",
			command: "prompt",
			success: true,
		});

		const restored = new CommandRecoveryJournal(path);
		expect(restored.begin("client-a", "command-a", "prompt")).toEqual({
			status: "complete",
			response: {
				id: "command-a",
				type: "response",
				command: "prompt",
				success: true,
			},
		});
	});

	it("ignores a truncated final append", () => {
		const path = createPath();
		const journal = new CommandRecoveryJournal(path);
		journal.begin("client-a", "command-a", "prompt");
		appendFileSync(path, '{"version":1,"type":"result"');

		const restored = new CommandRecoveryJournal(path);
		expect(restored.begin("client-a", "command-a", "prompt")).toEqual({ status: "pending" });
	});

	it("durably removes acknowledged results", () => {
		const path = createPath();
		const journal = new CommandRecoveryJournal(path);
		journal.begin("client-a", "command-a", "prompt");
		journal.recordResult("client-a", "command-a", {
			id: "command-a",
			type: "response",
			command: "prompt",
			success: true,
		});
		journal.acknowledge("client-a", "command-a");

		const restored = new CommandRecoveryJournal(path);
		expect(restored.begin("client-a", "command-a", "prompt")).toEqual({ status: "new" });
	});

	it("skips unsupported directory fsync on Windows but still fsyncs files", () => {
		const path = createPath();
		const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
		const fsync = vi.spyOn(fs, "fsyncSync");
		syncBuiltinESMExports();
		try {
			const journal = new CommandRecoveryJournal(path);
			journal.begin("client-a", "command-a", "prompt");
			journal.recordResult("client-a", "command-a", {
				id: "command-a",
				type: "response",
				command: "prompt",
				success: true,
			});

			expect(() => journal.acknowledge("client-a", "command-a")).not.toThrow();
			expect(fsync).toHaveBeenCalledTimes(4);
		} finally {
			fsync.mockRestore();
			syncBuiltinESMExports();
			platform.mockRestore();
		}
	});

	it("does not suppress unrelated directory fsync errors", () => {
		const path = createPath();
		const platform = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
		const originalFsyncSync = fs.fsyncSync;
		const fsync = vi.spyOn(fs, "fsyncSync").mockImplementation((descriptor) => {
			if (fs.fstatSync(descriptor).isDirectory()) {
				const error = new Error("directory sync failed") as NodeJS.ErrnoException;
				error.code = "EIO";
				throw error;
			}
			originalFsyncSync(descriptor);
		});
		syncBuiltinESMExports();
		try {
			const journal = new CommandRecoveryJournal(path);
			journal.begin("client-a", "command-a", "prompt");
			journal.recordResult("client-a", "command-a", {
				id: "command-a",
				type: "response",
				command: "prompt",
				success: true,
			});

			expect(() => journal.acknowledge("client-a", "command-a")).toThrow("directory sync failed");
		} finally {
			fsync.mockRestore();
			syncBuiltinESMExports();
			platform.mockRestore();
		}
	});
});
