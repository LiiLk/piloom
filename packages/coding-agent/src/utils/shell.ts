import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { spawnSync } from "child_process";
import { getBinDir } from "../config.js";
import { recordOrphanProcessState } from "../core/orphan-process-journal.js";

export interface ShellConfig {
	shell: string;
	args: string[];
}

/**
 * Find bash executable on PATH (cross-platform)
 */
function findBashOnPath(): string | null {
	if (process.platform === "win32") {
		// Windows: Use 'where', verify file existence, and probe the shell. The
		// system WSL shim can exist on PATH without a usable distribution.
		try {
			const result = spawnSync("where", ["bash.exe"], {
				encoding: "utf-8",
				timeout: 5000,
				windowsHide: true,
			});
			if (result.status === 0 && result.stdout) {
				for (const match of result.stdout
					.split(/\r?\n/)
					.map((line) => line.trim())
					.filter(Boolean)) {
					if (!existsSync(match)) continue;
					try {
						const probe = spawnSync(match, ["-c", "exit 0"], {
							stdio: "ignore",
							timeout: 5000,
							windowsHide: true,
						});
						if (probe.status === 0) return match;
					} catch {
						// Continue to the next PATH candidate.
					}
				}
			}
		} catch {
			// Ignore errors
		}
		return null;
	}

	// Unix: Use 'which' and trust its output (handles Termux and special filesystems)
	try {
		const result = spawnSync("which", ["bash"], {
			encoding: "utf-8",
			timeout: 5000,
		});
		if (result.status === 0 && result.stdout) {
			const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
			if (firstMatch) {
				return firstMatch;
			}
		}
	} catch {
		// Ignore errors
	}
	return null;
}

/**
 * Resolve shell configuration based on platform and an optional explicit shell path.
 * Resolution order:
 * 1. User-specified shellPath
 * 2. On Windows: Git Bash in known locations, then bash on PATH
 * 3. On Unix: /bin/bash, then bash on PATH, then fallback to sh
 */
export function getShellConfig(customShellPath?: string): ShellConfig {
	// 1. Check user-specified shell path
	if (customShellPath) {
		if (existsSync(customShellPath)) {
			return { shell: customShellPath, args: ["-c"] };
		}
		throw new Error(`Custom shell path not found: ${customShellPath}`);
	}

	if (process.platform === "win32") {
		// 2. Try Git Bash in known locations
		const paths: string[] = [];
		const addGitBashPath = (...parts: string[]) => {
			const path = join(...parts);
			if (!paths.includes(path)) paths.push(path);
		};
		for (const programFiles of [
			process.env.ProgramFiles,
			process.env.ProgramW6432,
			process.env["ProgramFiles(x86)"],
		]) {
			if (programFiles) {
				// Git for Windows ships a launcher in bin and the actual MSYS2
				// shell in usr/bin. Prefer the actual runtime when it is present.
				addGitBashPath(programFiles, "Git", "usr", "bin", "bash.exe");
				addGitBashPath(programFiles, "Git", "bin", "bash.exe");
			}
		}
		if (process.env.LOCALAPPDATA) {
			addGitBashPath(process.env.LOCALAPPDATA, "Programs", "Git", "usr", "bin", "bash.exe");
			addGitBashPath(process.env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe");
		}

		for (const path of paths) {
			if (existsSync(path)) {
				return { shell: path, args: ["-c"] };
			}
		}

		// 3. Fallback: search bash.exe on PATH (Cygwin, MSYS2, WSL, etc.)
		const bashOnPath = findBashOnPath();
		if (bashOnPath) {
			return { shell: bashOnPath, args: ["-c"] };
		}

		throw new Error(
			`No bash shell found. Options:\n` +
				`  1. Install Git for Windows: https://git-scm.com/download/win\n` +
				`  2. Add your bash to PATH (Cygwin, MSYS2, etc.)\n` +
				"  3. Set shellPath in settings.json\n\n" +
				`Searched Git Bash in:\n${paths.map((p) => `  ${p}`).join("\n")}`,
		);
	}

	// Unix: try /bin/bash, then bash on PATH, then fallback to sh
	if (existsSync("/bin/bash")) {
		return { shell: "/bin/bash", args: ["-c"] };
	}

	const bashOnPath = findBashOnPath();
	if (bashOnPath) {
		return { shell: bashOnPath, args: ["-c"] };
	}

	return { shell: "sh", args: ["-c"] };
}

function getWindowsShellDirectories(shellPath?: string): string[] {
	const candidates = shellPath
		? [shellPath]
		: [
				process.env.ProgramFiles ? join(process.env.ProgramFiles, "Git", "usr", "bin", "bash.exe") : undefined,
				process.env.ProgramW6432 ? join(process.env.ProgramW6432, "Git", "usr", "bin", "bash.exe") : undefined,
				process.env["ProgramFiles(x86)"]
					? join(process.env["ProgramFiles(x86)"], "Git", "usr", "bin", "bash.exe")
					: undefined,
				process.env.LOCALAPPDATA
					? join(process.env.LOCALAPPDATA, "Programs", "Git", "usr", "bin", "bash.exe")
					: undefined,
			];
	return [
		...new Set(
			candidates
				.filter((candidate): candidate is string => Boolean(candidate))
				.filter((candidate) => existsSync(candidate))
				.map((candidate) => dirname(candidate)),
		),
	];
}

export function getShellEnv(shellPath?: string): NodeJS.ProcessEnv {
	const binDir = getBinDir();
	const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
	const currentPath = process.env[pathKey] ?? "";
	const pathEntries = currentPath.split(delimiter).filter(Boolean);
	const extraDirectories = process.platform === "win32" ? getWindowsShellDirectories(shellPath) : [];
	for (const directory of [binDir, ...extraDirectories].reverse()) {
		const hasDirectory = pathEntries.some((entry) =>
			process.platform === "win32" ? entry.toLowerCase() === directory.toLowerCase() : entry === directory,
		);
		if (!hasDirectory) {
			pathEntries.unshift(directory);
		}
	}

	return {
		...process.env,
		[pathKey]: pathEntries.join(delimiter),
	};
}

/**
 * Sanitize binary output for display/storage.
 * Removes characters that crash string-width or cause display issues:
 * - Control characters (except tab, newline, carriage return)
 * - Lone surrogates
 * - Unicode Format characters (crash string-width due to a bug)
 * - Characters with undefined code points
 */
export function sanitizeBinaryOutput(str: string): string {
	// Use Array.from to properly iterate over code points (not code units)
	// This handles surrogate pairs correctly and catches edge cases where
	// codePointAt() might return undefined
	return Array.from(str)
		.filter((char) => {
			// Filter out characters that cause string-width to crash
			// This includes:
			// - Unicode format characters
			// - Lone surrogates (already filtered by Array.from)
			// - Control chars except \t \n \r
			// - Characters with undefined code points

			const code = char.codePointAt(0);

			// Skip if code point is undefined (edge case with invalid strings)
			if (code === undefined) return false;

			// Allow tab, newline, carriage return
			if (code === 0x09 || code === 0x0a || code === 0x0d) return true;

			// Filter out control characters (0x00-0x1F, except 0x09, 0x0a, 0x0x0d)
			if (code <= 0x1f) return false;

			// Filter out Unicode format characters
			if (code >= 0xfff9 && code <= 0xfffb) return false;

			return true;
		})
		.join("");
}

/**
 * Detached child processes must be tracked so they can be killed on parent
 * shutdown signals (SIGHUP/SIGTERM).
 */
const trackedDetachedChildPids = new Set<number>();

export function trackDetachedChildPid(pid: number): void {
	trackedDetachedChildPids.add(pid);
	recordOrphanProcessState(pid, true);
}

export function untrackDetachedChildPid(pid: number): void {
	trackedDetachedChildPids.delete(pid);
	recordOrphanProcessState(pid, false);
}

export function killTrackedDetachedChildren(): void {
	for (const pid of trackedDetachedChildPids) {
		killProcessTree(pid);
		recordOrphanProcessState(pid, false);
	}
	trackedDetachedChildPids.clear();
}

/**
 * Kill a process and all its children (cross-platform)
 */
export function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		// Use taskkill on Windows to kill process tree
		try {
			const result = spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], {
				stdio: "ignore",
				windowsHide: true,
			});
			if (result.status === 0) {
				return;
			}
		} catch {
			// Fall through to the direct process signal.
		}
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// The process may already be fully reaped.
		}
	} else {
		// Use SIGKILL on Unix/Linux/Mac
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			// Fallback to killing just the child if process group kill fails
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Process already dead
			}
		}
	}
}
