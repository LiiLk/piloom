#!/usr/bin/env node

// The release tarball merges every workspace package into a single
// node_modules, so two packages cannot ask for different ranges of the same
// dependency. Checking it here fails the PR instead of the release.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUNDLED_PACKAGE_DIRS, MAIN_PACKAGE_DIR, resolveMainDependencies } from "./release-dependencies.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readPackageJson = (packageDir) => JSON.parse(readFileSync(join(root, "packages", packageDir, "package.json"), "utf8"));

try {
	const mainPackage = readPackageJson(MAIN_PACKAGE_DIR);
	const bundledPackages = BUNDLED_PACKAGE_DIRS.map((packageDir) => ({
		packageDir,
		packageJson: readPackageJson(packageDir),
	}));
	const internalPackageNames = new Set(bundledPackages.map(({ packageJson }) => packageJson.name));
	const { dependencies, optionalDependencies } = resolveMainDependencies({
		mainPackage,
		bundledPackages,
		internalPackageNames,
		releaseVersion: mainPackage.version,
	});

	const count = Object.keys(dependencies || {}).length + Object.keys(optionalDependencies || {}).length;
	const packageCount = bundledPackages.length + 1;
	console.log(`Release dependency checks passed (${count} dependencies merged across ${packageCount} packages).`);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
