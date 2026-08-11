#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	renameSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultOutputDir = join(root, "packages", "coding-agent", "release");
const publicPackageName = process.env.PRIME_AGENT_PACKAGE_NAME || "prime-agent";
const publicCommandName = process.env.PRIME_AGENT_CMD || "piloom";
const releaseChannels = new Set(["stable", "beta"]);

const releasePackages = [
	{ packageDir: "ai", publicName: undefined, artifactName: "prime-agent-ai" },
	{ packageDir: "tui", publicName: undefined, artifactName: "prime-agent-tui" },
	{ packageDir: "agent", publicName: undefined, artifactName: "prime-agent-core" },
	{ packageDir: "coding-agent", publicName: publicPackageName, artifactName: publicPackageName },
];

function parseArgs(args) {
	const parsed = {
		channel: "stable",
		outDir: defaultOutputDir,
		version: undefined,
	};

	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		switch (arg) {
			case "--channel": {
				const value = args[i + 1];
				if (!value || !releaseChannels.has(value)) {
					throw new Error("--channel must be stable or beta");
				}
				parsed.channel = value;
				i += 1;
				break;
			}
			case "--out-dir": {
				const value = args[i + 1];
				if (!value) throw new Error("--out-dir requires a value");
				parsed.outDir = resolve(root, value);
				i += 1;
				break;
			}
			case "--version": {
				const value = args[i + 1];
				if (!value) throw new Error("--version requires a value");
				parsed.version = normalizeVersion(value);
				i += 1;
				break;
			}
			case "--help":
			case "-h":
				printHelp();
				process.exit(0);
				break;
			default:
				throw new Error(`Unknown argument: ${arg}`);
		}
	}

	return parsed;
}

function printHelp() {
	console.log(`Usage: node scripts/pack-prime-agent-release.mjs [--channel stable|beta] [--version x.y.z] [--out-dir path]

Creates versioned npm tarballs for GitHub Releases:

  <out-dir>/artifacts/prime-agent-<version>.tgz
  <out-dir>/artifacts/prime-agent-ai-<version>.tgz
  <out-dir>/artifacts/prime-agent-core-<version>.tgz
  <out-dir>/artifacts/prime-agent-tui-<version>.tgz
  <out-dir>/artifacts/SHA256SUMS
  <out-dir>/artifacts/<channel>
  <out-dir>/artifacts/latest.json (stable) or beta.json (beta)
`);
}

function normalizeVersion(version) {
	const normalized = version.startsWith("v") ? version.slice(1) : version;
	if (!/^[0-9A-Za-z.-]+$/.test(normalized)) {
		throw new Error(`Invalid release version: ${version}`);
	}
	return normalized;
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function packagePath(packageDir) {
	return join(root, "packages", packageDir);
}

function assertSafeOutputDir(outDir) {
	const relativeToReleaseRoot = relative(defaultOutputDir, outDir);
	if (relativeToReleaseRoot === "" || (!relativeToReleaseRoot.startsWith("..") && !isAbsolute(relativeToReleaseRoot))) {
		return;
	}
	throw new Error(`Refusing to remove output directory outside ${defaultOutputDir}: ${outDir}`);
}

function packageJsonPath(packageDir) {
	return join(packagePath(packageDir), "package.json");
}

function requireBuiltPackage(packageDir) {
	const dist = join(packagePath(packageDir), "dist");
	if (!existsSync(dist)) {
		throw new Error(`Missing ${dist}. Run npm run build before packing a release.`);
	}
}

function copyIfExists(source, target) {
	if (existsSync(source)) {
		cpSync(source, target, { recursive: true });
	}
}

function npmTarballName(packageName, version) {
	return `${packageName.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;
}

function releaseTag(channel, version) {
	return channel === "beta" ? "beta" : `v${version}`;
}

function releaseTarballPath(channel, version, tarballFile) {
	return `releases/download/${releaseTag(channel, version)}/${tarballFile}`;
}

function copyDependencies(dependencies, internalPackageNames, releaseVersion) {
	if (!dependencies) return undefined;
	return Object.fromEntries(
		Object.entries(dependencies).map(([name, range]) => [
			name,
			internalPackageNames.has(name) ? releaseVersion : range,
		]),
	);
}

function releaseScripts(sourceScripts) {
	if (!sourceScripts?.postinstall) return undefined;
	return {
		postinstall: sourceScripts.postinstall,
	};
}

function createReleasePackageJson(
	sourcePackage,
	packageName,
	releaseVersion,
	internalPackageNames,
	bundledDependencies = [],
) {
	const packageJson = {
		...sourcePackage,
		name: packageName,
		version: releaseVersion,
		dependencies: copyDependencies(sourcePackage.dependencies, internalPackageNames, releaseVersion),
		optionalDependencies: copyDependencies(sourcePackage.optionalDependencies, internalPackageNames, releaseVersion),
		scripts: releaseScripts(sourcePackage.scripts),
	};

	delete packageJson.devDependencies;
	delete packageJson.overrides;
	delete packageJson.private;

	if (packageName === publicPackageName) {
		packageJson.bundledDependencies = bundledDependencies;
		packageJson.bin = {
			[publicCommandName]: "dist/bundle/cli.js",
		};
		packageJson.piConfig = {
			...(packageJson.piConfig || {}),
			commandName: publicCommandName,
			configDir: ".prime/agent",
		};
	}

	return packageJson;
}

function assertPinnedInternalDependencies(packageJson, internalPackageNames) {
	for (const dependencies of [packageJson.dependencies, packageJson.optionalDependencies]) {
		for (const [name, spec] of Object.entries(dependencies || {})) {
			if (internalPackageNames.has(name) && spec !== packageJson.version) {
				throw new Error(`${packageJson.name} must pin internal dependency ${name} to ${packageJson.version}.`);
			}
		}
	}
}

function copyPackageContents(sourceDir, targetDir, packageJson) {
	mkdirSync(targetDir, { recursive: true });
	writeJson(join(targetDir, "package.json"), packageJson);

	for (const entry of ["dist", "docs", "examples", "skills", "postinstall.cjs", "README.md", "CHANGELOG.md"]) {
		copyIfExists(join(sourceDir, entry), join(targetDir, entry));
	}
}

function copyBundledInternalPackages(
	mainStagingDir,
	sourcePackages,
	packageNames,
	sourcePackageNames,
	internalPackageNames,
	releaseVersion,
) {
	for (const releasePackage of releasePackages) {
		if (releasePackage.packageDir === "coding-agent") continue;
		const sourcePackage = sourcePackages.get(releasePackage.packageDir);
		const sourceName = sourcePackageNames.get(releasePackage.packageDir);
		const targetDir = join(mainStagingDir, "node_modules", ...sourceName.split("/"));
		const bundledPackageJson = createReleasePackageJson(
			sourcePackage,
			packageNames.get(releasePackage.packageDir),
			releaseVersion,
			internalPackageNames,
		);
		assertPinnedInternalDependencies(bundledPackageJson, internalPackageNames);
		copyPackageContents(
			packagePath(releasePackage.packageDir),
			targetDir,
			bundledPackageJson,
		);
	}
}

function assertBundledMainPackage(stagingDir, packageJson, bundledDependencies) {
	for (const dependencyName of bundledDependencies) {
		const dependencySpec = packageJson.dependencies?.[dependencyName] ?? packageJson.optionalDependencies?.[dependencyName];
		if (dependencySpec !== packageJson.version) {
			throw new Error(`Main release package must pin bundled dependency ${dependencyName} to ${packageJson.version}.`);
		}
	}
	const packageJsonText = JSON.stringify(packageJson);
	if (/releases\/download|\.tgz/i.test(packageJsonText)) {
		throw new Error("Main release package must not contain internal tarball URLs.");
	}
	const preview = JSON.parse(run("npm", ["pack", stagingDir, "--dry-run", "--json"], root));
	const files = new Set((preview[0]?.files || []).map((entry) => entry.path));
	for (const dependencyName of bundledDependencies) {
		const packagePathPrefix = `node_modules/${dependencyName}/package.json`;
		if (![...files].some((file) => file === packagePathPrefix || file === `package/${packagePathPrefix}`)) {
			throw new Error(`Main release tarball is missing bundled dependency ${dependencyName}.`);
		}
	}
}

const WINDOWS_SHELL_META_CHARACTERS = /([()\][%!^"`<>&|;, *?])/g;

function escapeWindowsShellValue(value, command) {
	if (/[\0\r\n]/.test(value)) {
		throw new Error("Windows command arguments cannot contain NUL or newline characters");
	}
	if (command) {
		return value.replace(WINDOWS_SHELL_META_CHARACTERS, "^$1");
	}
	const escaped = value.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"').replace(/(?=(\\+?)?)\1$/, "$1$1");
	return `"${escaped}"`.replace(WINDOWS_SHELL_META_CHARACTERS, "^$1");
}

function run(command, args, cwd) {
	const useWindowsShell = process.platform === "win32" && command === "npm";
	const shellCommand = useWindowsShell
		? [escapeWindowsShellValue("npm", true), ...args.map((argument) => escapeWindowsShellValue(argument, false))].join(
				" ",
			)
		: undefined;
	const invocationCommand = useWindowsShell ? (process.env.ComSpec ?? "cmd.exe") : command;
	const invocationArgs = shellCommand ? ["/d", "/s", "/c", `"${shellCommand}"`] : args;
	const result = spawnSync(invocationCommand, invocationArgs, {
		cwd,
		stdio: "pipe",
		encoding: "utf8",
		windowsVerbatimArguments: useWindowsShell,
		windowsHide: useWindowsShell,
	});

	if (result.status !== 0) {
		if (result.stdout) process.stdout.write(result.stdout);
		if (result.stderr) process.stderr.write(result.stderr);
		throw new Error(`${invocationCommand} ${args.join(" ")} failed with exit code ${result.status}`);
	}

	if (result.stderr) process.stderr.write(result.stderr);
	return result.stdout.trim();
}

function sha256File(path) {
	const hash = createHash("sha256");
	hash.update(readFileSync(path));
	return hash.digest("hex");
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const sourcePackages = new Map(
		releasePackages.map((releasePackage) => [
			releasePackage.packageDir,
			readJson(packageJsonPath(releasePackage.packageDir)),
		]),
	);
	const cliPackage = sourcePackages.get("coding-agent");
	const releaseVersion = args.version || normalizeVersion(process.env.PRIME_AGENT_VERSION || cliPackage.version);

	for (const releasePackage of releasePackages) {
		requireBuiltPackage(releasePackage.packageDir);
	}

	// Dependency keys stay on the source package names so existing compiled imports
	// keep resolving, while release package names and artifact filenames are branded.
	const sourcePackageNames = new Map();
	const packageNames = new Map();
	const artifactFiles = new Map();
	for (const releasePackage of releasePackages) {
		const sourcePackage = sourcePackages.get(releasePackage.packageDir);
		const packageName = releasePackage.publicName || sourcePackage.name;
		sourcePackageNames.set(releasePackage.packageDir, sourcePackage.name);
		packageNames.set(releasePackage.packageDir, packageName);
		artifactFiles.set(
			releasePackage.packageDir,
			npmTarballName(releasePackage.artifactName || packageName, releaseVersion),
		);
	}

	const bundledDependencies = releasePackages
		.filter((releasePackage) => releasePackage.packageDir !== "coding-agent")
		.map((releasePackage) => sourcePackageNames.get(releasePackage.packageDir));
	const internalPackageNames = new Set(bundledDependencies);

	const stagingRoot = join(args.outDir, "packages");
	const artifactsDir = join(args.outDir, "artifacts");
	assertSafeOutputDir(args.outDir);
	rmSync(args.outDir, { force: true, recursive: true });
	mkdirSync(stagingRoot, { recursive: true });
	mkdirSync(artifactsDir, { recursive: true });

	const tarballs = [];
	for (const releasePackage of releasePackages) {
		const sourcePackage = sourcePackages.get(releasePackage.packageDir);
		const packageName = packageNames.get(releasePackage.packageDir);
		const stagingDir = join(stagingRoot, releasePackage.packageDir);
		const packageJson = createReleasePackageJson(
			sourcePackage,
			packageName,
			releaseVersion,
			internalPackageNames,
			releasePackage.packageDir === "coding-agent" ? bundledDependencies : [],
		);
		assertPinnedInternalDependencies(packageJson, internalPackageNames);

		copyPackageContents(packagePath(releasePackage.packageDir), stagingDir, packageJson);
		if (releasePackage.packageDir === "coding-agent") {
			copyBundledInternalPackages(
				stagingDir,
				sourcePackages,
				packageNames,
				sourcePackageNames,
				internalPackageNames,
				releaseVersion,
			);
		}

		const tarballName = run("npm", ["pack", stagingDir, "--pack-destination", artifactsDir, "--silent"], root)
			.split("\n")
			.at(-1);
		if (!tarballName) {
			throw new Error(`npm pack did not report a tarball name for ${packageName}`);
		}

		const tarballPath = join(artifactsDir, basename(tarballName));
		if (!existsSync(tarballPath) || !statSync(tarballPath).isFile()) {
			throw new Error(`npm pack did not create ${tarballPath}`);
		}
		if (releasePackage.packageDir === "coding-agent") {
			assertBundledMainPackage(stagingDir, packageJson, bundledDependencies);
		}

		const artifactFile = artifactFiles.get(releasePackage.packageDir);
		const artifactPath = join(artifactsDir, artifactFile);
		if (tarballPath !== artifactPath) {
			rmSync(artifactPath, { force: true });
			renameSync(tarballPath, artifactPath);
		}

		tarballs.push({
			name: packageName,
			file: artifactFile,
			sha256: sha256File(artifactPath),
		});
	}

	tarballs.sort((left, right) => left.file.localeCompare(right.file));
	writeFileSync(
		join(artifactsDir, "SHA256SUMS"),
		tarballs.map((tarball) => `${tarball.sha256}  ${tarball.file}`).join("\n") + "\n",
	);
	writeFileSync(join(artifactsDir, args.channel), `v${releaseVersion}\n`);
	const manifestName = args.channel === "stable" ? "latest.json" : "beta.json";
	writeJson(join(artifactsDir, manifestName), {
		version: `v${releaseVersion}`,
		package: publicPackageName,
		tarball: releaseTarballPath(args.channel, releaseVersion, artifactFiles.get("coding-agent")),
		tarballs: tarballs.map((tarball) => ({
			package: tarball.name,
			file: tarball.file,
			sha256: tarball.sha256,
		})),
	});

	for (const tarball of tarballs) {
		console.log(`Created ${join(artifactsDir, tarball.file)}`);
	}
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
