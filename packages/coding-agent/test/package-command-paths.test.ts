import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockedDownloadVerifiedReleaseTarball } = vi.hoisted(() => ({
	mockedDownloadVerifiedReleaseTarball: vi.fn(),
}));
vi.mock("../src/utils/version-check.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/utils/version-check.js")>()),
	downloadVerifiedReleaseTarball: mockedDownloadVerifiedReleaseTarball,
}));

import {
	APP_NAME,
	ENV_AGENT_DIR,
	SELF_UPDATE_INTERACTIVE_CHILD_ENV,
	SELF_UPDATE_NOT_ATTEMPTED_EXIT_CODE,
	VERSION,
} from "../src/config.js";
import { main } from "../src/main.js";

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[name];
		return;
	}
	process.env[name] = value;
}

async function runSelfUpdateInstallChild(args: string[]): Promise<void> {
	const previousValue = process.env[SELF_UPDATE_INTERACTIVE_CHILD_ENV];
	process.env[SELF_UPDATE_INTERACTIVE_CHILD_ENV] = "1";
	try {
		await main(args);
	} finally {
		restoreEnv(SELF_UPDATE_INTERACTIVE_CHILD_ENV, previousValue);
	}
}

describe("package commands", () => {
	let tempDir: string;
	let agentDir: string;
	let projectDir: string;
	let packageDir: string;
	let originalCwd: string;
	let originalAgentDir: string | undefined;
	let originalPiPackageDir: string | undefined;
	let originalTmpDir: string | undefined;
	let originalExitCode: typeof process.exitCode;
	let originalExecPath: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-package-commands-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		projectDir = join(tempDir, "project");
		packageDir = join(tempDir, "local-package");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		mkdirSync(packageDir, { recursive: true });

		originalCwd = process.cwd();
		originalAgentDir = process.env[ENV_AGENT_DIR];
		originalPiPackageDir = process.env.PI_PACKAGE_DIR;
		originalTmpDir = process.env.TMPDIR;
		originalExitCode = process.exitCode;
		originalExecPath = process.execPath;
		process.exitCode = undefined;
		process.env[ENV_AGENT_DIR] = agentDir;
		process.env.TMPDIR = tempDir;
		process.chdir(projectDir);
	});

	afterEach(() => {
		mockedDownloadVerifiedReleaseTarball.mockReset();
		vi.unstubAllGlobals();
		process.chdir(originalCwd);
		process.exitCode = originalExitCode;
		restoreEnv(ENV_AGENT_DIR, originalAgentDir);
		restoreEnv("PI_PACKAGE_DIR", originalPiPackageDir);
		restoreEnv("TMPDIR", originalTmpDir);
		Object.defineProperty(process, "execPath", { value: originalExecPath, configurable: true });
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("should persist global relative local package paths relative to settings.json", async () => {
		const relativePkgDir = join(projectDir, "packages", "local-package");
		mkdirSync(relativePkgDir, { recursive: true });

		await main(["package", "install", "./packages/local-package"]);

		const settingsPath = join(agentDir, "settings.json");
		const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as { packages?: string[] };
		expect(settings.packages?.length).toBe(1);
		const stored = settings.packages?.[0] ?? "";
		const resolvedFromSettings = realpathSync(join(agentDir, stored));
		expect(resolvedFromSettings).toBe(realpathSync(relativePkgDir));
	});

	it("should remove local packages using a path with a trailing slash", async () => {
		await main(["package", "install", `${packageDir}/`]);

		const settingsPath = join(agentDir, "settings.json");
		const installedSettings = JSON.parse(readFileSync(settingsPath, "utf-8")) as { packages?: string[] };
		expect(installedSettings.packages?.length).toBe(1);

		await main(["package", "remove", `${packageDir}/`]);

		const removedSettings = JSON.parse(readFileSync(settingsPath, "utf-8")) as { packages?: string[] };
		expect(removedSettings.packages ?? []).toHaveLength(0);
	});

	it("shows install subcommand help", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["package", "install", "--help"])).resolves.toBeUndefined();

			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("Usage:");
			expect(stdout).toContain(`${APP_NAME} package install <source> [--local]`);
			expect(errorSpy).not.toHaveBeenCalled();
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("shows a friendly error for unknown install options", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["package", "install", "--unknown"])).resolves.toBeUndefined();

			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stderr).toContain('Unknown option --unknown for "install".');
			expect(stderr).toContain(`Use "${APP_NAME} --help" or "${APP_NAME} package install <source> [--local]".`);
			expect(process.exitCode).toBe(1);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("directs the removed -l package option to --local", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["package", "install", packageDir, "-l"])).resolves.toBeUndefined();

			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stderr).toContain('Option -l was removed. Use "--local".');
			expect(process.exitCode).toBe(1);
			expect(existsSync(join(agentDir, "settings.json"))).toBe(false);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("treats -l as an unknown option for package update", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["package", "update", "-l"])).resolves.toBeUndefined();

			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stderr).toContain('Unknown option -l for "update".');
			expect(stderr).not.toContain('Use "--local".');
			expect(process.exitCode).toBe(1);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("shows a friendly error for missing install source", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["package", "install"])).resolves.toBeUndefined();

			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stderr).toContain("Missing install source.");
			expect(stderr).toContain(`Usage: ${APP_NAME} package install <source> [--local]`);
			expect(stderr).not.toContain("at ");
			expect(process.exitCode).toBe(1);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("installs only the verified local tarball during a forced PiLoom self-update", async () => {
		const globalPrefix = join(tempDir, "global-prefix");
		const projectPrefix = join(tempDir, "project-prefix");
		const selfPackageDir = join(globalPrefix, "lib", "node_modules", "@earendil-works", "pi-coding-agent");
		const fakeNpmPath = join(tempDir, "fake-npm.cjs");
		const recordPath = join(tempDir, "self-update.json");
		mkdirSync(selfPackageDir, { recursive: true });
		writeFileSync(
			fakeNpmPath,
			`const fs=require("node:fs"),path=require("node:path"),args=process.argv.slice(2),prefix=args[args.indexOf("--prefix")+1];
if(args.includes("root")) console.log(path.join(prefix,"lib","node_modules"));
else { const records=fs.existsSync(${JSON.stringify(recordPath)})?JSON.parse(fs.readFileSync(${JSON.stringify(recordPath)},"utf-8")):[]; records.push(args); fs.writeFileSync(${JSON.stringify(recordPath)},JSON.stringify(records)); }
`,
		);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ npmCommand: [originalExecPath, fakeNpmPath, "--prefix", globalPrefix] }, null, 2),
		);
		mkdirSync(join(projectDir, ".prime", "agent"), { recursive: true });
		writeFileSync(
			join(projectDir, ".prime", "agent", "settings.json"),
			JSON.stringify({ npmCommand: [originalExecPath, fakeNpmPath, "--prefix", projectPrefix] }, null, 2),
		);
		process.env.PI_PACKAGE_DIR = selfPackageDir;
		Object.defineProperty(process, "execPath", {
			value: join(selfPackageDir, "dist", "cli.js"),
			configurable: true,
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					package: "prime-agent",
					tarball: "releases/download/v0.7.2/prime-agent-0.7.2.tgz",
					version: "0.7.2",
				}),
			),
		);
		mockedDownloadVerifiedReleaseTarball.mockImplementation(async (_release, destinationPath) => {
			writeFileSync(destinationPath, "verified tarball");
		});

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await expect(runSelfUpdateInstallChild(["update", "--self", "--force"])).resolves.toBeUndefined();
			expect(process.exitCode).toBeUndefined();
			expect(errorSpy).not.toHaveBeenCalled();
			expect(mockedDownloadVerifiedReleaseTarball).toHaveBeenCalledOnce();
			const recordedCalls = JSON.parse(readFileSync(recordPath, "utf-8")) as string[][];
			const installCall = recordedCalls.find((args) => args.includes("install"));
			expect(installCall).toBeDefined();
			const localTarball = installCall?.find((arg) => arg.includes("prime-agent-0.7.2.tgz"));
			expect(localTarball).toBeDefined();
			expect(localTarball).not.toMatch(/^https?:/);
			expect(installCall).toContain(globalPrefix);
			expect(installCall).not.toContain(projectPrefix);
		} finally {
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("does not download or install when the signed release manifest reports the current version", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					package: "prime-agent",
					tarball: `releases/download/v${VERSION}/prime-agent-${VERSION}.tgz`,
					version: VERSION,
				}),
			),
		);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await expect(runSelfUpdateInstallChild(["update", "--self"])).resolves.toBeUndefined();
			expect(process.exitCode).toBe(SELF_UPDATE_NOT_ATTEMPTED_EXIT_CODE);
			expect(errorSpy).not.toHaveBeenCalled();
			expect(logSpy.mock.calls.map(([message]) => String(message)).join("\n")).toContain("already up to date");
			expect(mockedDownloadVerifiedReleaseTarball).not.toHaveBeenCalled();
		} finally {
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("refuses a forced downgrade to an older signed release", async () => {
		const olderVersion = "0.0.0";
		expect(VERSION).not.toBe(olderVersion);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					package: "prime-agent",
					tarball: `releases/download/v${olderVersion}/prime-agent-${olderVersion}.tgz`,
					version: olderVersion,
				}),
			),
		);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await expect(runSelfUpdateInstallChild(["update", "--self", "--force"])).resolves.toBeUndefined();
			expect(process.exitCode).toBe(1);
			expect(errorSpy.mock.calls.map(([message]) => String(message)).join("\n")).toContain("downgrade refused");
			expect(mockedDownloadVerifiedReleaseTarball).not.toHaveBeenCalled();
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("fails closed without invoking npm when verified release download fails", async () => {
		const globalPrefix = join(tempDir, "global-prefix");
		const selfPackageDir = join(globalPrefix, "lib", "node_modules", "@earendil-works", "pi-coding-agent");
		const fakeNpmPath = join(tempDir, "fake-npm.cjs");
		const recordPath = join(tempDir, "self-update-fail.json");
		mkdirSync(selfPackageDir, { recursive: true });
		writeFileSync(
			fakeNpmPath,
			`require("node:fs").writeFileSync(${JSON.stringify(recordPath)}, "npm invoked"); process.exit(23);`,
		);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ npmCommand: [originalExecPath, fakeNpmPath, "--prefix", globalPrefix] }, null, 2),
		);
		process.env.PI_PACKAGE_DIR = selfPackageDir;
		Object.defineProperty(process, "execPath", {
			value: join(selfPackageDir, "dist", "cli.js"),
			configurable: true,
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					package: "prime-agent",
					tarball: "releases/download/v0.7.2/prime-agent-0.7.2.tgz",
					version: "0.7.2",
				}),
			),
		);
		mockedDownloadVerifiedReleaseTarball.mockRejectedValueOnce(new Error("checksum tampered"));

		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await expect(runSelfUpdateInstallChild(["update", "--self"])).resolves.toBeUndefined();
			expect(process.exitCode).toBe(1);
			expect(errorSpy.mock.calls.map(([message]) => String(message)).join("\n")).toContain("checksum tampered");
			expect(existsSync(recordPath)).toBe(false);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("fails closed without invoking npm when the GitHub release manifest is unavailable", async () => {
		const globalPrefix = join(tempDir, "global-prefix");
		const selfPackageDir = join(globalPrefix, "lib", "node_modules", "@earendil-works", "pi-coding-agent");
		const fakeNpmPath = join(tempDir, "fake-npm-unavailable.cjs");
		const recordPath = join(tempDir, "self-update-unavailable.json");
		mkdirSync(selfPackageDir, { recursive: true });
		writeFileSync(
			fakeNpmPath,
			`require("node:fs").writeFileSync(${JSON.stringify(recordPath)}, "npm invoked"); process.exit(23);`,
		);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ npmCommand: [originalExecPath, fakeNpmPath, "--prefix", globalPrefix] }, null, 2),
		);
		process.env.PI_PACKAGE_DIR = selfPackageDir;
		Object.defineProperty(process, "execPath", {
			value: join(selfPackageDir, "dist", "cli.js"),
			configurable: true,
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(null, { status: 404 })),
		);

		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await expect(runSelfUpdateInstallChild(["update", "--self"])).resolves.toBeUndefined();
			expect(process.exitCode).toBe(1);
			expect(errorSpy.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
				"manifest is unavailable or invalid",
			);
			expect(mockedDownloadVerifiedReleaseTarball).not.toHaveBeenCalled();
			expect(existsSync(recordPath)).toBe(false);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("suggests the configured source when update input omits the npm prefix", async () => {
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(settingsPath, JSON.stringify({ packages: ["npm:pi-formatter"] }, null, 2));

		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(main(["package", "update", "pi-formatter"])).resolves.toBeUndefined();

			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stderr).toContain("Did you mean npm:pi-formatter?");
			expect(stdout).not.toContain("Updated pi-formatter");
			expect(process.exitCode).toBe(1);

			const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as { packages?: string[] };
			expect(settings.packages).toContain("npm:pi-formatter");
		} finally {
			errorSpy.mockRestore();
			logSpy.mockRestore();
		}
	});
});
