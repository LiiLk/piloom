import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const childProcessMocks = vi.hoisted(() => ({
	spawnSync: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
}));

vi.mock("child_process", () => ({ spawnSync: childProcessMocks.spawnSync }));

import { getShellConfig, getShellEnv, killProcessTree } from "../src/utils/shell.js";

afterEach(() => {
	vi.restoreAllMocks();
	childProcessMocks.spawnSync.mockClear();
});

describe("Windows shell compatibility", () => {
	it("finds a per-user Git Bash installation", () => {
		const root = join(tmpdir(), `coding-agent-shell-test-${Date.now()}`);
		const bashPath = join(root, "Programs", "Git", "usr", "bin", "bash.exe");
		mkdirSync(join(root, "Programs", "Git", "usr", "bin"), { recursive: true });
		writeFileSync(bashPath, "fake bash");

		const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
		const originalEnvironment = process.env;
		process.env = {
			...originalEnvironment,
			ProgramFiles: "",
			ProgramW6432: "",
			"ProgramFiles(x86)": "",
			LOCALAPPDATA: root,
		};

		try {
			expect(getShellConfig()).toEqual({ shell: bashPath, args: ["-c"] });
		} finally {
			process.env = originalEnvironment;
			platform.mockRestore();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("uses the first existing bash path returned by where", () => {
		const root = join(tmpdir(), `coding-agent-shell-path-test-${Date.now()}`);
		const bashPath = join(root, "bash.exe");
		mkdirSync(root, { recursive: true });
		writeFileSync(bashPath, "fake bash");
		childProcessMocks.spawnSync.mockReturnValue({
			status: 0,
			stdout: `${join(root, "missing-bash.exe")}\r\n${bashPath}\r\n`,
			stderr: "",
		});

		const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
		const originalEnvironment = process.env;
		process.env = {
			...originalEnvironment,
			ProgramFiles: "",
			ProgramW6432: "",
			"ProgramFiles(x86)": "",
			LOCALAPPDATA: "",
		};

		try {
			expect(getShellConfig()).toEqual({ shell: bashPath, args: ["-c"] });
		} finally {
			process.env = originalEnvironment;
			platform.mockRestore();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps Git Bash core utilities on the child PATH", () => {
		const root = join(tmpdir(), `coding-agent-shell-env-test-${Date.now()}`);
		const bashPath = join(root, "Git", "usr", "bin", "bash.exe");
		mkdirSync(dirname(bashPath), { recursive: true });
		writeFileSync(bashPath, "fake bash");

		const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
		const originalEnvironment = process.env;
		process.env = {
			...originalEnvironment,
			PATH: "C:\\Windows\\System32",
		};

		try {
			const shellEnv = getShellEnv(bashPath);
			expect(shellEnv.PATH?.split(delimiter)).toContain(dirname(bashPath));
		} finally {
			process.env = originalEnvironment;
			platform.mockRestore();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("kills Windows process trees synchronously without detaching taskkill", () => {
		vi.spyOn(process, "platform", "get").mockReturnValue("win32");

		killProcessTree(1234);

		expect(childProcessMocks.spawnSync).toHaveBeenCalledWith("taskkill", ["/F", "/T", "/PID", "1234"], {
			stdio: "ignore",
			windowsHide: true,
		});
	});
});
