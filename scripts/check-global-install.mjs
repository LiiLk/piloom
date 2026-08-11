#!/usr/bin/env node

/**
 * Installs the packed release tarball the way users do and checks the result.
 *
 * `npm install --global` nests every dependency under the installed package,
 * while a local install hoists them to the top level. Only the global layout
 * exercises what the installer produces, which is why a broken release tarball
 * can pass every other check: v0.7.3 shipped with koffi, chalk, marked, typebox
 * and undici created as empty directories.
 *
 * Run after `npm run build`.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runNpm } from "./run-npm.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packageName = process.env.PRIME_AGENT_PACKAGE_NAME || "prime-agent";
const commandName = process.env.PRIME_AGENT_CMD || "piloom";
const artifactsDir = join(root, "packages", "coding-agent", "release", "artifacts");

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

// Every directory that npm created for a dependency must hold a real package.
function findEmptyDependencies(nodeModulesDir) {
	const empty = [];
	for (const entry of readdirSync(nodeModulesDir, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.name === ".bin") continue;
		const entryDir = join(nodeModulesDir, entry.name);
		if (entry.name.startsWith("@")) {
			for (const scoped of readdirSync(entryDir, { withFileTypes: true })) {
				if (!scoped.isDirectory()) continue;
				if (!existsSync(join(entryDir, scoped.name, "package.json"))) {
					empty.push(`${entry.name}/${scoped.name}`);
				}
			}
			continue;
		}
		if (!existsSync(join(entryDir, "package.json"))) empty.push(entry.name);
	}
	return empty;
}

function commandShimPath(prefix) {
	return process.platform === "win32" ? join(prefix, `${commandName}.cmd`) : join(prefix, "bin", commandName);
}

function main() {
	const version = readJson(join(root, "packages", "coding-agent", "package.json")).version;
	const tarball = join(artifactsDir, `${packageName}-${version}.tgz`);

	console.log(`Packing ${packageName}@${version}`);
	runNpm(["run", "release:pack"], root);
	if (!existsSync(tarball)) throw new Error(`Release packer did not create ${tarball}`);

	const prefix = mkdtempSync(join(tmpdir(), "piloom-global-install-"));
	try {
		console.log(`Installing globally into ${prefix}`);
		// The bootstrap environment variables stay unset so the postinstall does
		// not download the search tools or the IPython runtime here.
		runNpm(["install", "--global", "--prefix", prefix, "--no-fund", "--no-audit", "--loglevel=error", tarball], root);

		// Global packages live under <prefix>/lib/node_modules on POSIX and
		// <prefix>/node_modules on Windows, so ask npm instead of guessing.
		const packageDir = join(runNpm(["root", "--global", "--prefix", prefix], root), packageName);
		const nodeModulesDir = join(packageDir, "node_modules");
		if (!existsSync(nodeModulesDir)) throw new Error(`${packageName} was installed without dependencies.`);

		const empty = findEmptyDependencies(nodeModulesDir);
		if (empty.length > 0) {
			throw new Error(`npm created these dependencies as empty directories: ${empty.join(", ")}`);
		}

		const shim = commandShimPath(prefix);
		if (!existsSync(shim)) throw new Error(`The install did not create the ${commandName} command shim: ${shim}`);

		const cli = join(packageDir, "dist", "bundle", "cli.js");
		const result = spawnSync(process.execPath, [cli, "--version"], { encoding: "utf8" });
		if (result.status !== 0) {
			if (result.stdout) process.stdout.write(result.stdout);
			if (result.stderr) process.stderr.write(result.stderr);
			throw new Error(`${commandName} --version exited with ${result.status}`);
		}
		// The CLI currently prints the version on stderr; this check is about the
		// install being usable, not about which stream the version lands on.
		const printed = `${result.stdout}${result.stderr}`.trim();
		if (printed !== version) {
			throw new Error(`${commandName} --version printed "${printed}", expected "${version}"`);
		}

		const installed = readdirSync(nodeModulesDir).length;
		console.log(
			`Global install check passed (${installed} dependencies installed, none empty, ${commandName} ${version} runs).`,
		);
	} finally {
		rmSync(prefix, { force: true, recursive: true });
	}
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
