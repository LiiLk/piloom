/**
 * Runs npm from a Node script.
 *
 * On Windows npm is a `.cmd` shim, so it can only be started through the
 * command interpreter. Every argument is escaped for that interpreter and the
 * command line is passed verbatim, which keeps paths containing spaces or shell
 * metacharacters from being reinterpreted.
 */

import { spawnSync } from "node:child_process";

const WINDOWS_SHELL_META_CHARACTERS = /([()\][%!^"`<>&|;, *?])/g;

export function escapeWindowsShellValue(value, command) {
	if (/[\0\r\n]/.test(value)) {
		throw new Error("Windows command arguments cannot contain NUL or newline characters");
	}
	if (command) {
		return value.replace(WINDOWS_SHELL_META_CHARACTERS, "^$1");
	}
	const escaped = value.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"').replace(/(?=(\\+?)?)\1$/, "$1$1");
	return `"${escaped}"`.replace(WINDOWS_SHELL_META_CHARACTERS, "^$1");
}

/**
 * @param {string[]} args npm arguments, e.g. ["pack", dir]
 * @param {string} cwd working directory
 * @returns {string} trimmed stdout
 */
export function runNpm(args, cwd) {
	const useWindowsShell = process.platform === "win32";
	const shellCommand = useWindowsShell
		? [escapeWindowsShellValue("npm", true), ...args.map((argument) => escapeWindowsShellValue(argument, false))].join(
				" ",
			)
		: undefined;
	const command = useWindowsShell ? (process.env.ComSpec ?? "cmd.exe") : "npm";
	const invocationArgs = shellCommand ? ["/d", "/s", "/c", `"${shellCommand}"`] : args;
	const result = spawnSync(command, invocationArgs, {
		cwd,
		stdio: "pipe",
		encoding: "utf8",
		windowsVerbatimArguments: useWindowsShell,
		windowsHide: useWindowsShell,
	});

	if (result.status !== 0) {
		if (result.stdout) process.stdout.write(result.stdout);
		if (result.stderr) process.stderr.write(result.stderr);
		throw new Error(`npm ${args.join(" ")} failed with exit code ${result.status}`);
	}

	if (result.stderr) process.stderr.write(result.stderr);
	return result.stdout.trim();
}
