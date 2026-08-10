import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { APP_NAME, ENV_AGENT_DIR } from "../src/config.js";

interface CodingAgentPackage {
	bin?: Record<string, string>;
	scripts?: Record<string, string>;
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");

function readRepositoryFile(path: string): string {
	return readFileSync(resolve(repositoryRoot, path), "utf8");
}

describe("PiLoom public command contract", () => {
	it("publishes piloom as the package command and standalone executable", () => {
		const packageJson = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8")) as CodingAgentPackage;
		const crossPlatformBuilder = readRepositoryFile("scripts/build-binaries.sh");
		const windowsBuilder = readRepositoryFile("scripts/build-windows-binary.ps1");

		expect(packageJson.bin).toEqual({ piloom: "dist/bundle/cli.js" });
		expect(readRepositoryFile("piloom.cmd")).toContain("--tsconfig");
		expect(packageJson.scripts?.["build:binary"]).toContain("--outfile dist/piloom");
		expect(readRepositoryFile("scripts/pack-prime-agent-release.mjs")).toContain(
			'process.env.PRIME_AGENT_CMD || "piloom"',
		);
		expect(readRepositoryFile("scripts/pack-prime-agent-release.mjs")).toContain("commandName: publicCommandName");
		expect(windowsBuilder).toContain('"dist\\piloom.exe"');
		expect(windowsBuilder).toContain("Expand-Archive -LiteralPath $archivePath");
		expect(crossPlatformBuilder).toContain('darwin-arm64) koffi_target="darwin_arm64"');
		expect(crossPlatformBuilder).toContain('linux-x64) koffi_target="linux_x64"');
		expect(crossPlatformBuilder).toContain('windows-x64) koffi_target="win32_x64"');
		expect(readRepositoryFile("install.sh")).toContain(`prime_agent_cmd="\${PRIME_AGENT_CMD:-piloom}"`);
	});

	it("uses piloom publicly without changing the Prime Agent environment namespace", () => {
		expect(APP_NAME).toBe("piloom");
		expect(ENV_AGENT_DIR).toBe("PRIME_AGENT_CODING_AGENT_DIR");
	});

	it("installs piloom on the Windows user command path", () => {
		const installer = readRepositoryFile("install.ps1");

		expect(installer).toContain('else { "piloom" }');
		expect(installer).toContain("npm prefix --global");
		expect(installer).toContain('[Environment]::SetEnvironmentVariable("Path"');
		expect(installer).toContain('"$Name.cmd"');
	});

	it.skipIf(process.platform !== "win32")("launches the complete source CLI outside the repository", () => {
		const workingDirectory = mkdtempSync(resolve(tmpdir(), "piloom-source-launch-"));
		try {
			const result = spawnSync(
				process.env.ComSpec ?? "cmd.exe",
				["/d", "/c", resolve(repositoryRoot, "piloom.cmd"), "--help"],
				{
					cwd: workingDirectory,
					encoding: "utf8",
					windowsHide: true,
				},
			);

			expect(result.error).toBeUndefined();
			expect(result.status).toBe(0);
			expect(`${result.stdout}${result.stderr}`).toContain("piloom - AI coding assistant");
		} finally {
			rmSync(workingDirectory, { force: true, recursive: true });
		}
	});
});
