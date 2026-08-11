/**
 * Dependency layout rules shared by the release packer and `npm run check`.
 *
 * The main release tarball ships the internal packages (ai, tui, agent) as
 * bundled dependencies inside its own node_modules, and those copies have no
 * node_modules of their own. Everything they import therefore has to be
 * installed right next to them, in the main package's node_modules.
 *
 * npm never extracts a package it considers part of a bundle. During
 * `npm install --global` every dependency is nested under the installed
 * package, so a dependency that is reachable from a bundled package ends up as
 * an empty directory: koffi then fails its install script ("Cannot find module
 * src/cnoke/cnoke.js") and chalk, marked, typebox and undici are silently
 * missing. Declaring every dependency on the main package only - and stripping
 * them from the bundled copies - keeps them outside the bundle so npm installs
 * them normally.
 *
 * The single node_modules also means the workspace packages cannot disagree on
 * a range: only one copy of each dependency is installed.
 */

export const MAIN_PACKAGE_DIR = "coding-agent";
export const BUNDLED_PACKAGE_DIRS = ["ai", "tui", "agent"];

/**
 * Merges the dependencies of the main package and of every bundled package into
 * the single dependency set the main release package must declare.
 *
 * @param {object} options
 * @param {object} options.mainPackage packages/coding-agent/package.json
 * @param {Array<{ packageDir: string, packageJson: object }>} options.bundledPackages
 * @param {Set<string>} options.internalPackageNames names shipped inside the tarball
 * @param {string} options.releaseVersion version the internal packages are pinned to
 * @returns {{ dependencies: object | undefined, optionalDependencies: object | undefined }}
 */
export function resolveMainDependencies({ mainPackage, bundledPackages, internalPackageNames, releaseVersion }) {
	/** @type {Map<string, { range: string, packageDir: string, optional: boolean }>} */
	const merged = new Map();

	const add = (name, range, packageDir, optional) => {
		const existing = merged.get(name);
		if (existing && existing.range !== range) {
			throw new Error(
				`packages/${existing.packageDir} requires ${name}@${existing.range} but ` +
					`packages/${packageDir} requires ${name}@${range}. The release installs a single copy of each ` +
					"dependency, so both package.json files must use the same range.",
			);
		}
		// A package that any release package requires cannot stay optional.
		merged.set(name, { range, packageDir, optional: (existing?.optional ?? true) && optional });
	};

	const collect = ({ packageDir, packageJson }) => {
		for (const [name, range] of Object.entries(packageJson.dependencies || {})) {
			if (internalPackageNames.has(name)) continue;
			add(name, range, packageDir, false);
		}
		for (const [name, range] of Object.entries(packageJson.optionalDependencies || {})) {
			if (internalPackageNames.has(name)) continue;
			add(name, range, packageDir, true);
		}
	};

	collect({ packageDir: MAIN_PACKAGE_DIR, packageJson: mainPackage });
	for (const bundledPackage of bundledPackages) collect(bundledPackage);

	const dependencies = {};
	const optionalDependencies = {};
	// The bundled packages are the only dependencies that keep a pinned version.
	for (const name of internalPackageNames) {
		if (mainPackage.dependencies?.[name]) dependencies[name] = releaseVersion;
		if (mainPackage.optionalDependencies?.[name]) optionalDependencies[name] = releaseVersion;
	}
	for (const [name, { range, optional }] of merged) {
		if (optional) optionalDependencies[name] = range;
		else dependencies[name] = range;
	}

	return {
		dependencies: Object.keys(dependencies).length > 0 ? sortByName(dependencies) : undefined,
		optionalDependencies: Object.keys(optionalDependencies).length > 0 ? sortByName(optionalDependencies) : undefined,
	};
}

function sortByName(record) {
	return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
}
