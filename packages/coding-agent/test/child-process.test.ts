import { type ChildProcess, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	prepareWindowsShellInvocation,
	shouldUseWindowsShell,
	signalProcessGroupOrProcess,
	waitForChildProcess,
} from "../src/utils/child-process.js";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("shouldUseWindowsShell", () => {
	it("recognizes Windows executable paths with either separator", () => {
		vi.spyOn(process, "platform", "get").mockReturnValue("win32");

		expect(shouldUseWindowsShell("C:/Program Files/nodejs/npm.cmd")).toBe(true);
		expect(shouldUseWindowsShell("C:\\Program Files\\nodejs\\npm.cmd")).toBe(true);
		expect(shouldUseWindowsShell("bun")).toBe(true);
		expect(shouldUseWindowsShell("bun.cmd")).toBe(true);
		expect(shouldUseWindowsShell("C:\\Program Files\\Git\\cmd\\git.exe")).toBe(false);
	});

	it("does not change POSIX shell selection", () => {
		vi.spyOn(process, "platform", "get").mockReturnValue("linux");

		expect(shouldUseWindowsShell("/usr/local/bin/npm.cmd")).toBe(false);
	});

	it.runIf(process.platform === "win32")("preserves shell metacharacters as literal command arguments", () => {
		const args = [
			"plain",
			"two words",
			"amp&ersand",
			"paren(value)",
			"caret^value",
			"pipe|value",
			'quote"value',
			'safe" & echo PILOOM_INJECTED & rem "',
			"percent%PATH%value",
		];
		const invocation = prepareWindowsShellInvocation(resolve(__dirname, "fixtures/echo-args.cmd"), args);
		const result = spawnSync(invocation.command, invocation.args, {
			encoding: "utf8",
			windowsVerbatimArguments: invocation.windowsVerbatimArguments,
			windowsHide: true,
		});

		expect(result.status, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual(args);
	});

	it("rejects command-line control characters before spawning a Windows shell", () => {
		vi.spyOn(process, "platform", "get").mockReturnValue("win32");

		expect(() => prepareWindowsShellInvocation("npm", ["safe\r\necho injected"])).toThrow(
			"cannot contain NUL or newline",
		);
	});
});

describe("signalProcessGroupOrProcess", () => {
	it("does not try a negative PID on Windows", () => {
		vi.spyOn(process, "platform", "get").mockReturnValue("win32");
		const kill = vi.spyOn(process, "kill").mockImplementation(() => true);

		signalProcessGroupOrProcess(1234, "SIGTERM");

		expect(kill).toHaveBeenCalledWith(1234, "SIGTERM");
		expect(kill).not.toHaveBeenCalledWith(-1234, "SIGTERM");
	});

	it("falls back to the process when a POSIX group is unavailable", () => {
		vi.spyOn(process, "platform", "get").mockReturnValue("linux");
		const kill = vi.spyOn(process, "kill").mockImplementation((pid) => {
			if (pid < 0) throw new Error("no process group");
			return true;
		});

		signalProcessGroupOrProcess(1234, "SIGKILL");

		expect(kill).toHaveBeenNthCalledWith(1, -1234, "SIGKILL");
		expect(kill).toHaveBeenNthCalledWith(2, 1234, "SIGKILL");
	});
});

describe("waitForChildProcess", () => {
	it("reports signaled already-exited children as failures", async () => {
		const child = Object.assign(new EventEmitter(), {
			stdout: null,
			stderr: null,
			exitCode: null,
			signalCode: "SIGTERM" as NodeJS.Signals,
		});

		await expect(waitForChildProcess(child as unknown as ChildProcess)).resolves.toBe(143);
	});
});
