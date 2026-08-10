import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakeChildProcess = vi.hoisted(() => {
	type PythonConfig = { modules: Set<string>; runtimeReady: boolean };
	type VenvHandler = (venv: string) => void;
	type LogWriter = (line: string) => void;
	type ExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;

	const uvPaths = new Set<string>();
	const pythonConfigs = new Map<string, PythonConfig>();
	let venvHandler: VenvHandler | undefined;
	let logWriter: LogWriter | undefined;

	const normalizePath = (value: string): string => (process.platform === "win32" ? value.toLowerCase() : value);

	const createChild = (exitCode: number): ChildProcess => {
		let exitListener: ExitListener | undefined;
		const child = {
			on: (event: string, listener: (...args: never[]) => void) => {
				if (event === "exit") {
					exitListener = listener as ExitListener;
					queueMicrotask(() => exitListener?.(exitCode, null));
				}
				return child;
			},
		} as unknown as ChildProcess;
		return child;
	};

	const spawn = (command: string, args: readonly string[]): ChildProcess => {
		const normalizedCommand = normalizePath(command);
		if (uvPaths.has(normalizedCommand)) {
			logWriter?.(args.join(" "));
			if (args[0] === "venv") venvHandler?.(args[1] ?? "");
			const failedArgument = process.env.UV_FAIL_ARG;
			const exitCode = args[0] === "pip" && failedArgument !== undefined && args.includes(failedArgument) ? 1 : 0;
			return createChild(exitCode);
		}

		const python = pythonConfigs.get(normalizedCommand);
		if (!python) return createChild(1);
		const code = args[0] === "-c" ? (args[1] ?? "") : "";
		if (code.includes("from rlm import McpIntegration")) return createChild(python.runtimeReady ? 0 : 1);
		const importName = code.match(/^import ([A-Za-z0-9_.-]+)$/)?.[1];
		return createChild(importName !== undefined && python.modules.has(importName) ? 0 : 1);
	};

	return {
		spawn,
		configureUv(path: string, onVenvCreated: VenvHandler, writeLog: LogWriter): void {
			uvPaths.add(normalizePath(path));
			venvHandler = onVenvCreated;
			logWriter = writeLog;
		},
		registerPython(path: string, modules: readonly string[], runtimeReady = modules.includes("rlm")): void {
			pythonConfigs.set(normalizePath(path), { modules: new Set(modules), runtimeReady });
		},
		registerPythonFromScript(path: string, content: string): void {
			const modules = [...content.matchAll(/"import ([A-Za-z0-9_.-]+)"/g)].map((match) => match[1]);
			this.registerPython(path, modules, content.includes('"_harness_methods"*) exit 0'));
		},
		reset(): void {
			uvPaths.clear();
			pythonConfigs.clear();
			venvHandler = undefined;
			logWriter = undefined;
		},
	};
});

vi.mock("node:child_process", () => ({ spawn: fakeChildProcess.spawn }));

import {
	DEFAULT_RLM_EXTRA_IMPORT_NAMES,
	DEFAULT_RLM_EXTRA_UV_ARGS,
	ensureKernelPython,
	findUvExecutable,
	getKernelVenvDir,
	getKernelVenvPythonPath,
	getUvExecutableCandidates,
	getUvInstallInvocation,
	type KernelPythonSkill,
	resolveRuntimeIdentity,
} from "../src/core/kernel/bootstrap.js";

let tempDir = "";
let originalEnv: NodeJS.ProcessEnv;
let runtimeIdentity = "";

function pyprojectHash(pyprojectPath: string): string {
	return `sha256:${createHash("sha256").update(readFileSync(pyprojectPath)).digest("hex")}`;
}

function kernelPythonPath(venv: string): string {
	return getKernelVenvPythonPath(venv);
}

function kernelPythonDirectory(venv: string): string {
	return join(venv, process.platform === "win32" ? "Scripts" : "bin");
}

function writeExecutable(filePath: string, content: string): void {
	writeFileSync(filePath, content);
	chmodSync(filePath, 0o755);
	if (filePath.toLowerCase().endsWith("python") || filePath.toLowerCase().endsWith("python.exe")) {
		fakeChildProcess.registerPythonFromScript(filePath, content);
	}
}

function writeBootstrapVersion(venv: string, pythonSkills: readonly KernelPythonSkill[] = []): void {
	writeFileSync(
		join(venv, ".bootstrap-version"),
		`${JSON.stringify({
			schema: 8,
			ipykernel: "ipykernel",
			runtime: runtimeIdentity,
			snapshot: "dill",
			extraUvArgs: DEFAULT_RLM_EXTRA_UV_ARGS,
			pythonSkills: pythonSkills.map((skill) => ({
				importName: skill.importName,
				packagePath: skill.packagePath,
				pyprojectPath: skill.pyprojectPath,
				pyprojectHash: pyprojectHash(skill.pyprojectPath),
			})),
		})}\n`,
	);
}

function createPythonSkill(name = "web-search"): KernelPythonSkill {
	const packagePath = join(tempDir, "skills", name);
	const importName = name.replaceAll("-", "_");
	const pyprojectPath = join(packagePath, "pyproject.toml");
	mkdirSync(join(packagePath, "src", importName), { recursive: true });
	writeFileSync(
		pyprojectPath,
		`[project]
name = "${name}"
version = "0.1.0"
`,
	);
	writeFileSync(join(packagePath, "src", importName, "__init__.py"), "async def run():\n    return 'ok'\n");
	return {
		name,
		importName,
		packagePath,
		pyprojectPath,
	};
}

function createPythonSkillWithDependency(name: string, dependencyName: string): KernelPythonSkill {
	const skill = createPythonSkill(name);
	writeFileSync(
		skill.pyprojectPath,
		`[project]
name = "${name}"
version = "0.1.0"
dependencies = ["${dependencyName}"]
`,
	);
	return skill;
}

function writeFakePython(filePath: string, importableModules: readonly string[]): void {
	const cases = importableModules.map((moduleName) => `    "import ${moduleName}") exit 0 ;;`).join("\n");
	const runtimeCase = importableModules.includes("rlm") ? '    *"_harness_methods"*) exit 0 ;;' : "";
	writeExecutable(
		filePath,
		[
			"#!/bin/sh",
			'if [ "$1" = "-c" ]; then',
			'  case "$2" in',
			cases,
			runtimeCase,
			"    *) exit 1 ;;",
			"  esac",
			"fi",
			"exit 0",
			"",
		].join("\n"),
	);
	fakeChildProcess.registerPython(filePath, importableModules);
}

function installFakeUv(): string {
	const binDir = join(tempDir, "bin");
	mkdirSync(binDir, { recursive: true });
	const logPath = join(tempDir, "uv.log");
	const uvPath = join(binDir, process.platform === "win32" ? "uv.exe" : "uv");
	const bootstrapModules = ["ipykernel", "rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES];
	process.env.UV_LOG = logPath;
	process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ""}`;
	writeExecutable(uvPath, "fake uv\n");
	fakeChildProcess.configureUv(
		uvPath,
		(venv) => {
			const python = kernelPythonPath(venv);
			mkdirSync(kernelPythonDirectory(venv), { recursive: true });
			writeFileSync(python, "fake python\n");
			fakeChildProcess.registerPython(python, bootstrapModules);
		},
		(line) => appendFileSync(logPath, `${line}\n`),
	);
	return logPath;
}

describe("kernel bootstrap", () => {
	beforeEach(async () => {
		runtimeIdentity = await resolveRuntimeIdentity();
		originalEnv = { ...process.env };
		tempDir = mkdtempSync(join(tmpdir(), "prime-agent-kernel-bootstrap-"));
		process.env.HOME = tempDir;
		process.env.USERPROFILE = tempDir;
		process.env.PATH = originalEnv.PATH ?? "";
		delete process.env.PRIME_AGENT_KERNEL_PYTHON;
		delete process.env.PRIME_AGENT_KERNEL_VENV;
		delete process.env.UV_INSTALL_DIR;
		delete process.env.UV_UNMANAGED_INSTALL;
		delete process.env.XDG_DATA_HOME;
	});

	afterEach(() => {
		fakeChildProcess.reset();
		process.env = originalEnv;
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	it("returns the configured kernel venv directory", () => {
		const venv = join(tempDir, "custom-venv");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		expect(getKernelVenvDir()).toBe(venv);
	});

	it("resolves platform-specific venv interpreter paths", () => {
		const venv = join(tempDir, "kernel-venv");

		expect(getKernelVenvPythonPath(venv, "win32")).toBe(join(venv, "Scripts", "python.exe"));
		expect(getKernelVenvPythonPath(venv, "linux")).toBe(join(venv, "bin", "python"));
	});

	it("discovers uv from a Windows user executable directory", async () => {
		const uvPath = join(tempDir, ".local", "bin", "uv.exe");
		mkdirSync(join(tempDir, ".local", "bin"), { recursive: true });
		writeExecutable(uvPath, "installed uv\n");
		process.env.UV_INSTALL_DIR = join(tempDir, ".local", "bin");
		process.env.PATH = "";
		const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");

		try {
			expect(getUvExecutableCandidates()).toContain(uvPath);
			expect(await findUvExecutable()).toBe(uvPath);
		} finally {
			platformSpy.mockRestore();
		}
	});

	it("treats UV_UNMANAGED_INSTALL as the uv executable directory", async () => {
		const installDir = join(tempDir, "managed-tools");
		const uvPath = join(installDir, "uv.exe");
		mkdirSync(installDir, { recursive: true });
		writeExecutable(uvPath, "installed uv\n");
		process.env.UV_UNMANAGED_INSTALL = installDir;
		process.env.PATH = "";
		const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");

		try {
			expect(getUvExecutableCandidates()).toContain(uvPath);
			expect(await findUvExecutable()).toBe(uvPath);
		} finally {
			platformSpy.mockRestore();
		}
	});

	it("selects the platform-specific uv installer without executing it", () => {
		expect(getUvInstallInvocation("win32")).toEqual({
			command: "powershell",
			args: ["-ExecutionPolicy", "ByPass", "-c", "irm https://astral.sh/uv/install.ps1 | iex"],
			display: 'powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"',
		});
		expect(getUvInstallInvocation("linux")).toEqual({
			command: "sh",
			args: ["-c", "curl -LsSf https://astral.sh/uv/install.sh | sh"],
			display: "curl -LsSf https://astral.sh/uv/install.sh | sh",
		});
	});

	it("bootstraps a missing venv with uv, ipykernel, prime-agent-runtime, and default extra packages", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		await expect(ensureKernelPython()).resolves.toBe(kernelPythonPath(venv));

		const log = readFileSync(logPath, "utf8");
		expect(log).toContain("python install 3.11");
		expect(log).toContain(`venv ${venv} --python 3.11 --seed`);
		expect(log).toContain("pip install --python");
		expect(log).toContain("ipykernel");
		expect(log).toContain("prime-agent-runtime");
		expect(log).toContain("dill");
		for (const uvArg of DEFAULT_RLM_EXTRA_UV_ARGS) {
			expect(log).toContain(uvArg);
		}
		const version = JSON.parse(readFileSync(join(venv, ".bootstrap-version"), "utf8"));
		expect(version).toEqual({
			schema: 8,
			ipykernel: "ipykernel",
			runtime: runtimeIdentity,
			snapshot: "dill",
			extraUvArgs: DEFAULT_RLM_EXTRA_UV_ARGS,
			pythonSkills: [],
		});
		expect(version.runtime).toMatch(/^sha256:/);
	});

	it("routes bootstrap progress through the provided callback", async () => {
		installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const progress: string[] = [];
		process.env.PRIME_AGENT_KERNEL_VENV = venv;
		const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		try {
			await expect(ensureKernelPython({ onProgress: (message) => progress.push(message) })).resolves.toBe(
				kernelPythonPath(venv),
			);
		} finally {
			stderrWrite.mockRestore();
		}

		expect(progress).toEqual(expect.arrayContaining(["› setting up python kernel (one-time, ~30s)…", "✓ ready"]));
		expect(stderrWrite).not.toHaveBeenCalledWith(expect.stringContaining("setting up python kernel"));
		expect(stderrWrite).not.toHaveBeenCalledWith(expect.stringContaining("ready"));
	});

	it("installs Python skills into the bootstrapped venv", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const pythonSkill = createPythonSkill();
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		await expect(ensureKernelPython({ pythonSkills: [pythonSkill] })).resolves.toBe(kernelPythonPath(venv));

		const log = readFileSync(logPath, "utf8");
		expect(log).toContain(`--editable ${pythonSkill.packagePath}`);
		const version = JSON.parse(readFileSync(join(venv, ".bootstrap-version"), "utf8"));
		expect(version.pythonSkills).toEqual([
			{
				importName: pythonSkill.importName,
				packagePath: pythonSkill.packagePath,
				pyprojectPath: pythonSkill.pyprojectPath,
				pyprojectHash: pyprojectHash(pythonSkill.pyprojectPath),
			},
		]);
	});

	it("installs sibling Python skill dependencies with dependent editable packages", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const dependencySkill = createPythonSkill("agent-observe");
		const dependentSkill = createPythonSkillWithDependency("orchestration-heartbeat", "agent-observe");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		await expect(ensureKernelPython({ pythonSkills: [dependentSkill] })).resolves.toBe(kernelPythonPath(venv));

		const log = readFileSync(logPath, "utf8");
		expect(log).toContain(`--editable ${dependencySkill.packagePath}`);
		expect(log).toContain(`--editable ${dependentSkill.packagePath}`);
		const version = JSON.parse(readFileSync(join(venv, ".bootstrap-version"), "utf8"));
		expect(version.pythonSkills).toEqual([
			{
				importName: dependencySkill.importName,
				packagePath: dependencySkill.packagePath,
				pyprojectPath: dependencySkill.pyprojectPath,
				pyprojectHash: pyprojectHash(dependencySkill.pyprojectPath),
			},
			{
				importName: dependentSkill.importName,
				packagePath: dependentSkill.packagePath,
				pyprojectPath: dependentSkill.pyprojectPath,
				pyprojectHash: pyprojectHash(dependentSkill.pyprojectPath),
			},
		]);
	});

	it("installs sibling Python skill dependencies when package and directory names differ", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const dependencySkill = createPythonSkill("attach-image");
		writeFileSync(
			dependencySkill.pyprojectPath,
			`[project]
name = "prime-agent-skill-attach-image"
version = "0.1.0"
`,
		);
		const dependentSkill = createPythonSkillWithDependency(
			"orchestration-heartbeat",
			"prime-agent-skill-attach-image",
		);
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		await expect(ensureKernelPython({ pythonSkills: [dependentSkill] })).resolves.toBe(kernelPythonPath(venv));

		const log = readFileSync(logPath, "utf8");
		expect(log).toContain(`--editable ${dependencySkill.packagePath}`);
		expect(log).toContain(`--editable ${dependentSkill.packagePath}`);
	});

	it("parses Python skill dependencies with extras", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const dependencySkill = createPythonSkill("gidgethub");
		const dependentSkill = createPythonSkillWithDependency("orchestration-heartbeat", "gidgethub[httpx]>4.0.0");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		await expect(ensureKernelPython({ pythonSkills: [dependentSkill] })).resolves.toBe(kernelPythonPath(venv));

		const log = readFileSync(logPath, "utf8");
		expect(log).toContain(`--editable ${dependencySkill.packagePath}`);
		expect(log).toContain(`--editable ${dependentSkill.packagePath}`);
	});

	it("syncs a warm venv when a Python skill pyproject changes", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const python = kernelPythonPath(venv);
		const pythonSkill = createPythonSkill();
		mkdirSync(kernelPythonDirectory(venv), { recursive: true });
		writeFakePython(python, ["ipykernel", "rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES]);
		writeBootstrapVersion(venv, [pythonSkill]);
		writeFileSync(
			pythonSkill.pyprojectPath,
			`[project]
name = "${pythonSkill.name}"
version = "0.1.0"
dependencies = ["httpx"]
`,
		);
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		await expect(ensureKernelPython({ pythonSkills: [pythonSkill] })).resolves.toBe(python);

		const log = readFileSync(logPath, "utf8");
		expect(log).not.toContain(`venv ${venv} --python 3.11 --seed`);
		expect(log).toContain(`--editable ${pythonSkill.packagePath}`);
		const version = JSON.parse(readFileSync(join(venv, ".bootstrap-version"), "utf8"));
		expect(version.pythonSkills[0].pyprojectHash).toBe(pyprojectHash(pythonSkill.pyprojectPath));
	});

	it("continues when a Python skill editable install fails and retries it next startup", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const goodSkill = createPythonSkill("good-skill");
		const brokenSkill = createPythonSkill("broken-skill");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;
		process.env.UV_FAIL_ARG = brokenSkill.packagePath;

		await expect(ensureKernelPython({ pythonSkills: [goodSkill, brokenSkill] })).resolves.toBe(
			kernelPythonPath(venv),
		);

		const log = readFileSync(logPath, "utf8");
		expect(log).toContain(`--editable ${goodSkill.packagePath}`);
		expect(log).toContain(`--editable ${brokenSkill.packagePath}`);
		const version = JSON.parse(readFileSync(join(venv, ".bootstrap-version"), "utf8"));
		expect(version.pythonSkills).toEqual([
			{
				importName: goodSkill.importName,
				packagePath: goodSkill.packagePath,
				pyprojectPath: goodSkill.pyprojectPath,
				pyprojectHash: pyprojectHash(goodSkill.pyprojectPath),
			},
		]);

		await expect(ensureKernelPython({ pythonSkills: [goodSkill, brokenSkill] })).resolves.toBe(
			kernelPythonPath(venv),
		);

		const retryLog = readFileSync(logPath, "utf8");
		expect(retryLog.split("\n").filter((line) => line.startsWith(`venv ${venv} `))).toHaveLength(1);
		expect(
			retryLog.split("\n").filter((line) => line.includes(`--editable ${brokenSkill.packagePath}`)),
		).toHaveLength(2);
	});

	it("rebuilds a warm venv with legacy unhashed Python skill manifest entries", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const python = kernelPythonPath(venv);
		const pythonSkill = createPythonSkill();
		mkdirSync(kernelPythonDirectory(venv), { recursive: true });
		writeFakePython(python, ["ipykernel", "rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES]);
		writeFileSync(
			join(venv, ".bootstrap-version"),
			`${JSON.stringify({
				schema: 4,
				ipykernel: "ipykernel",
				runtime: "prime-agent-runtime",
				extraUvArgs: DEFAULT_RLM_EXTRA_UV_ARGS,
				pythonSkills: [
					{
						importName: pythonSkill.importName,
						packagePath: pythonSkill.packagePath,
						pyprojectPath: pythonSkill.pyprojectPath,
					},
				],
			})}\n`,
		);
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		await expect(ensureKernelPython()).resolves.toBe(python);

		expect(readFileSync(logPath, "utf8")).toContain(`venv ${venv} --python 3.11 --seed`);
	});

	it("shares concurrent bootstrap work in one process", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const python = kernelPythonPath(venv);
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		await expect(Promise.all([ensureKernelPython(), ensureKernelPython()])).resolves.toEqual([python, python]);

		const log = readFileSync(logPath, "utf8");
		expect(log.split("\n").filter((line) => line.startsWith(`venv ${venv} `))).toHaveLength(1);
	});

	it("reuses a current warm venv without invoking uv", async () => {
		const venv = join(tempDir, "kernel-venv");
		const python = kernelPythonPath(venv);
		mkdirSync(kernelPythonDirectory(venv), { recursive: true });
		writeFakePython(python, ["ipykernel", "rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES]);
		writeBootstrapVersion(venv);
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		await expect(ensureKernelPython()).resolves.toBe(python);
	});

	it("rebuilds a warm venv whose recorded runtime hash no longer matches local source", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const python = kernelPythonPath(venv);
		mkdirSync(kernelPythonDirectory(venv), { recursive: true });
		writeFakePython(python, ["ipykernel", "rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES]);
		writeFileSync(
			join(venv, ".bootstrap-version"),
			`${JSON.stringify({
				schema: 8,
				ipykernel: "ipykernel",
				runtime: "sha256:stale",
				snapshot: "dill",
				extraUvArgs: DEFAULT_RLM_EXTRA_UV_ARGS,
				pythonSkills: [],
			})}\n`,
		);
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		await expect(ensureKernelPython()).resolves.toBe(python);

		expect(readFileSync(logPath, "utf8")).toContain(`venv ${venv} --python 3.11 --seed`);
		const version = JSON.parse(readFileSync(join(venv, ".bootstrap-version"), "utf8"));
		expect(version.runtime).toBe(runtimeIdentity);
	});

	it("rebuilds a warm venv with a stale rlm runtime", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const python = kernelPythonPath(venv);
		mkdirSync(kernelPythonDirectory(venv), { recursive: true });
		writeExecutable(
			python,
			[
				"#!/bin/sh",
				'if [ "$1" = "-c" ]; then',
				'  case "$2" in',
				'    "import ipykernel"|"import rlm") exit 0 ;;',
				"    *) exit 1 ;;",
				"  esac",
				"fi",
				"exit 0",
				"",
			].join("\n"),
		);
		writeBootstrapVersion(venv);
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		await expect(ensureKernelPython()).resolves.toBe(python);

		expect(readFileSync(logPath, "utf8")).toContain(`venv ${venv} --python 3.11 --seed`);
	});

	it("rebuilds a broken venv", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		mkdirSync(kernelPythonDirectory(venv), { recursive: true });
		writeBootstrapVersion(venv);
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		await expect(ensureKernelPython()).resolves.toBe(kernelPythonPath(venv));

		expect(readFileSync(logPath, "utf8")).toContain(`venv ${venv} --python 3.11 --seed`);
	});

	it("uses PRIME_AGENT_KERNEL_PYTHON as an override contract", async () => {
		const overridePython = join(tempDir, "override-python");
		writeFakePython(overridePython, ["ipykernel", "rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES]);
		process.env.PRIME_AGENT_KERNEL_PYTHON = overridePython;

		await expect(ensureKernelPython()).resolves.toBe(overridePython);
	});

	it("allows PRIME_AGENT_KERNEL_PYTHON missing Python skill imports", async () => {
		const overridePython = join(tempDir, "override-python");
		const pythonSkill = createPythonSkill();
		writeFakePython(overridePython, ["ipykernel", "rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES]);
		process.env.PRIME_AGENT_KERNEL_PYTHON = overridePython;

		await expect(ensureKernelPython({ pythonSkills: [pythonSkill] })).resolves.toBe(overridePython);
	});

	it("rejects PRIME_AGENT_KERNEL_PYTHON missing default extra packages", async () => {
		const overridePython = join(tempDir, "override-python");
		writeFakePython(overridePython, [
			"ipykernel",
			"rlm",
			...DEFAULT_RLM_EXTRA_IMPORT_NAMES.filter((name) => name !== "yaml"),
		]);
		process.env.PRIME_AGENT_KERNEL_PYTHON = overridePython;

		await expect(ensureKernelPython()).rejects.toThrow(/default Python packages \(yaml \(PyYAML\)\)/);
	});

	it("rejects PRIME_AGENT_KERNEL_PYTHON with a stale rlm runtime", async () => {
		const overridePython = join(tempDir, "override-python");
		writeFakePython(overridePython, ["ipykernel"]);
		process.env.PRIME_AGENT_KERNEL_PYTHON = overridePython;

		await expect(ensureKernelPython()).rejects.toThrow(/current prime-agent-runtime with callable rlm\.run/);
	});

	it("rejects PRIME_AGENT_KERNEL_PYTHON with a legacy harness API", async () => {
		const overridePython = join(tempDir, "override-python");
		writeExecutable(
			overridePython,
			[
				"#!/bin/sh",
				'if [ "$1" = "-c" ]; then',
				'  case "$2" in',
				'    "import ipykernel"|"import rlm") exit 0 ;;',
				'    *"_harness_methods"*) exit 1 ;;',
				"    *\"assert not hasattr(rlm.rlm, 'background')\"*) exit 0 ;;",
				"    *) exit 1 ;;",
				"  esac",
				"fi",
				"exit 0",
				"",
			].join("\n"),
		);
		process.env.PRIME_AGENT_KERNEL_PYTHON = overridePython;

		await expect(ensureKernelPython()).rejects.toThrow(/current prime-agent-runtime with callable rlm\.run/);
	});

	it("fails an invalid PRIME_AGENT_KERNEL_PYTHON without bootstrapping", async () => {
		const overridePython = join(tempDir, "override-python");
		writeFakePython(overridePython, []);
		process.env.PRIME_AGENT_KERNEL_PYTHON = overridePython;

		await expect(ensureKernelPython()).rejects.toThrow(/missing ipykernel/);
	});
});
