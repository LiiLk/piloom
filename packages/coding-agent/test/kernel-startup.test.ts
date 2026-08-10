import type * as ChildProcessModule from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const childProcessMock = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof ChildProcessModule>()),
	spawn: childProcessMock.spawn,
}));

import { KernelManager } from "../src/core/kernel/index.js";

let tempDir = "";

describe("KernelManager startup", () => {
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "prime-agent-kernel-startup-"));
	});

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	it("surfaces kernels that exit before resolving ports", async () => {
		childProcessMock.spawn.mockImplementation(() => {
			const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter; kill: () => boolean };
			child.stderr = new EventEmitter();
			child.kill = () => true;
			queueMicrotask(() => {
				child.stderr.emit("data", Buffer.from("fake kernel died before binding\n"));
				child.emit("exit", 42, null);
			});
			return child as unknown as ChildProcess;
		});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const manager = new KernelManager({
			python: process.execPath,
			cwd: tempDir,
		});

		try {
			await expect(manager.execute("print(1)")).rejects.toThrow(
				/Kernel exited before resolving ports[\s\S]*fake kernel died before binding/,
			);
		} finally {
			errorSpy.mockRestore();
			await manager.dispose();
		}
	});
});
