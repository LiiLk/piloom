import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
const bashCommand = process.platform === "win32" ? gitBash : "bash";
if (process.platform === "win32" && !existsSync(gitBash)) {
	console.log("Beta publication transaction test skipped on Windows (Git Bash is required).");
	process.exit(0);
}
const root = fileURLToPath(new URL("..", import.meta.url));
const transaction = join(root, "scripts", "publish-beta-release.sh");
const tempRoot = mkdtempSync(join(tmpdir(), "piloom-beta-transaction-"));
const fakeGhPath = join(tempRoot, "gh");
const fakeJqPath = join(tempRoot, "jq");
const toShellPath = (path) => {
	if (process.platform !== "win32") return path;
	const result = spawnSync(bashCommand, ["-lc", 'cygpath -u "$1"', "bash", path], { encoding: "utf8" });
	if (result.status !== 0) throw new Error(`Could not convert path for Git Bash: ${path}`);
	return result.stdout.trim();
};
const shellTransaction = toShellPath(transaction);
const fakeGhSource = `#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const statePath = process.env.FAKE_GH_STATE;
const state = JSON.parse(readFileSync(statePath, "utf8"));
const args = process.argv.slice(2);
const repo = process.env.GITHUB_REPOSITORY;
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2) + "\\n");
const fail = (message) => { console.error(message); save(); process.exit(1); };
const notFound = () => fail("gh: Not Found (HTTP 404)");
const option = (name, fallback = "") => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const boolOption = (name, fallback) => {
  const inline = args.find((value) => value.startsWith(name + "="));
  if (inline) return inline.slice(name.length + 1) === "true";
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (value && !value.startsWith("-")) return value === "true";
  return true;
};
const releaseForTag = (tag) => state.releases[tag];
const requireRelease = (tag) => releaseForTag(tag) ?? fail("release not found: " + tag);
const apiPath = (value) => value.replace(/^https?:\\/\\/[^/]+\\//, "").replace(/^repos\\/[^/]+\\/[^/]+\\//, "");
const parseFields = () => {
  const fields = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "-f" && args[index] !== "-F") continue;
    const [key, ...rest] = String(args[index + 1]).split("=");
    fields[key] = rest.join("=");
  }
  return fields;
};
const releaseJson = (release) => ({
  databaseId: release.id,
  id: release.id,
  tagName: release.tagName,
  tag_name: release.tagName,
  isDraft: release.isDraft,
  draft: release.isDraft,
  isPrerelease: release.isPrerelease,
  prerelease: release.isPrerelease,
  name: release.name,
  body: release.body,
  targetCommitish: release.targetCommitish,
  target_commitish: release.targetCommitish,
  assets: Object.keys(release.assets).map((name) => ({ name })),
});
const printJson = (value) => process.stdout.write(JSON.stringify(value) + "\\n");

if (args[0] === "release") {
  const command = args[1];
  const tag = args[2];
  if (command === "view") {
    if (!releaseForTag(tag)) process.exit(1);
    printJson(releaseJson(requireRelease(tag)));
  } else if (command === "create") {
    const notesPath = option("--notes-file");
    const release = {
      id: String(state.nextId++), tagName: tag, isDraft: boolOption("--draft", false),
      isPrerelease: boolOption("--prerelease", false), name: option("--title", tag),
      body: notesPath ? readFileSync(notesPath, "utf8") : "", targetCommitish: option("--target"), assets: {},
    };
    state.releases[tag] = release;
    state.refs[tag] = release.targetCommitish;
  } else if (command === "upload") {
    const release = requireRelease(tag);
    for (const path of args.slice(3).filter((value) => !value.startsWith("-"))) {
      const name = basename(path);
      if (!existsSync(path)) fail("missing upload path: " + path);
      release.assets[name] = readFileSync(path, "utf8");
    }
  } else if (command === "download") {
    const release = requireRelease(tag);
    const name = option("--pattern");
    const dir = option("--dir");
    if (!(name in release.assets)) fail("missing asset: " + name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), release.assets[name]);
  } else if (command === "edit") {
    const release = requireRelease(tag);
    if (args.includes("--title")) release.name = option("--title");
    if (args.includes("--target")) release.targetCommitish = option("--target");
    if (args.includes("--notes-file")) release.body = readFileSync(option("--notes-file"), "utf8");
    release.isDraft = boolOption("--draft", release.isDraft);
    release.isPrerelease = boolOption("--prerelease", release.isPrerelease);
  } else if (command === "delete") {
    if (!releaseForTag(tag)) process.exit(1);
    delete state.releases[tag];
  } else {
    fail("unsupported release command: " + command);
  }
  save();
  process.exit(0);
}

if (args[0] !== "api") fail("unsupported gh command");
const method = option("--method", "GET").toUpperCase();
const rawPath = args.find((value) => value.startsWith("repos/"));
if (!rawPath) fail("missing API path");
const path = apiPath(rawPath);
const fields = parseFields();
if (path === "git/refs" && method === "POST") {
  const tag = String(fields.ref || "").replace(/^refs\\/tags\\//, "");
  if (!tag || !fields.sha) fail("invalid ref creation");
  state.refs[tag] = fields.sha;
  save();
  process.exit(0);
}
const refMatch = path.match(/^git\\/(?:ref|refs)\\/tags\\/(.+)$/);
if (refMatch) {
  const tag = refMatch[1];
  if (method === "GET") {
    if (!(tag in state.refs)) notFound();
    const value = { object: { sha: state.refs[tag] } };
    if (args.includes("--jq")) process.stdout.write(state.refs[tag] + "\\n"); else printJson(value);
  } else if (method === "DELETE") {
    if (!(tag in state.refs)) process.exit(1);
    delete state.refs[tag];
  } else if (method === "PATCH") {
    if (!(tag in state.refs)) process.exit(1);
    state.refs[tag] = fields.sha;
  } else if (method === "POST") {
    state.refs[tag] = fields.sha;
  } else fail("unsupported ref method: " + method);
  save();
  process.exit(0);
}

const releaseTagMatch = path.match(/^releases\\/tags\\/(.+)$/);
if (releaseTagMatch) {
  const releaseTag = releaseTagMatch[1];
  if (process.env.FAKE_GH_RELEASE_VIEW_ERROR === releaseTag) fail("gh: Service Unavailable (HTTP 503)");
  if (!releaseForTag(releaseTag)) notFound();
  const release = releaseForTag(releaseTag);
  if (method !== "GET") fail("unsupported release tag method");
  if (args.includes("--jq")) process.stdout.write(String(release.id) + "\\n"); else printJson(releaseJson(release));
  process.exit(0);
}

const releaseMatch = path.match(/^releases\\/(.+)$/);
if (!releaseMatch) fail("unsupported API path: " + path);
const id = releaseMatch[1];
const tag = Object.keys(state.releases).find((key) => String(state.releases[key].id) === id);
if (!tag) fail("release id not found: " + id);
const release = state.releases[tag];
if (method === "GET") {
  printJson(releaseJson(release));
} else if (method === "DELETE") {
  delete state.releases[tag];
} else if (method === "PATCH") {
  const nextTag = fields.tag_name || tag;
  delete state.releases[tag];
  release.tagName = nextTag;
  release.targetCommitish = fields.target_commitish || release.targetCommitish;
  release.name = fields.name || release.name;
  release.body = fields.body ?? release.body;
  if (fields.draft !== undefined) release.isDraft = fields.draft === "true";
  if (fields.prerelease !== undefined) release.isPrerelease = fields.prerelease === "true";
  state.releases[nextTag] = release;
  if (!(nextTag in state.refs)) state.refs[nextTag] = release.targetCommitish;
} else fail("unsupported release method: " + method);
save();
`;

const fakeJqSource = `#!/usr/bin/env node
import { readFileSync } from "node:fs";
const args = process.argv.slice(2);
const expression = args.find((value) => value.startsWith("."));
const file = args.find((value) => value !== "-r" && value !== "-e" && value !== expression);
const input = file ? readFileSync(file, "utf8") : readFileSync(0, "utf8");
const value = JSON.parse(input);
const output = (result) => process.stdout.write(String(result) + "\\n");
switch (expression) {
  case ".id": output(value.id); break;
  case ".databaseId": output(value.databaseId); break;
  case '.body // ""': output(value.body ?? ""); break;
  case ".draft // false": output(value.draft ?? false); break;
  case ".isDraft // false": output(value.isDraft ?? false); break;
  case ".prerelease // true": output(value.prerelease ?? true); break;
  case ".isPrerelease // true": output(value.isPrerelease ?? true); break;
  case '.name // ""': output(value.name ?? ""); break;
  case '.name // "Beta"': output(value.name ?? "Beta"); break;
  case ".target_commitish // empty": output(value.target_commitish ?? ""); break;
  case ".targetCommitish // empty": output(value.targetCommitish ?? ""); break;
  case '.draft == false and .prerelease == true and .tag_name == "beta"':
    process.exit(value.draft === false && value.prerelease === true && value.tag_name === "beta" ? 0 : 1);
  case '.isDraft == false and .isPrerelease == true and .tagName == "beta"':
    process.exit(value.isDraft === false && value.isPrerelease === true && value.tagName === "beta" ? 0 : 1);
  default: console.error("unsupported jq expression: " + expression); process.exit(2);
}
`;

writeFileSync(fakeGhPath, fakeGhSource, "utf8");
chmodSync(fakeGhPath, 0o755);
writeFileSync(fakeJqPath, fakeJqSource, "utf8");
chmodSync(fakeJqPath, 0o755);

const run = (state, failpoint = "", { releaseViewErrorTag = "" } = {}) => {
	const statePath = join(tempRoot, `state-${Math.random().toString(16).slice(2)}.json`);
	writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf8");
	const betaDir = join(tempRoot, "beta");
	const windowsDir = join(tempRoot, "windows");
	const installerDir = join(tempRoot, "installers");
	for (const dir of [betaDir, windowsDir, installerDir]) mkdirSync(dir, { recursive: true });
	writeFileSync(join(tempRoot, "notes.md"), "automated beta notes\n");
	writeFileSync(join(betaDir, "prime-agent-2.0.0-beta.1.tgz"), "new npm package\n");
	writeFileSync(join(betaDir, "SHA256SUMS"), "new sums\n");
	writeFileSync(join(betaDir, "beta"), "v2.0.0-beta.1\n");
	writeFileSync(join(betaDir, "beta.json"), "{\"version\":\"v2.0.0-beta.1\"}\n");
	writeFileSync(join(windowsDir, "piloom-2.0.0-beta.1-windows-x64.zip"), "new windows\n");
	writeFileSync(join(windowsDir, "piloom-2.0.0-beta.1-windows-x64.zip.sha256"), "new win sums\n");
	writeFileSync(join(windowsDir, "piloom-2.0.0-beta.1-windows-x64.zip.sha256.sig"), "new win sig\n");
	writeFileSync(join(installerDir, "install-beta.sh"), "new sh installer\n");
	writeFileSync(join(installerDir, "install-beta.ps1"), "new ps installer\n");
	const result = spawnSync(bashCommand, [shellTransaction], {
		cwd: root,
		env: {
			...process.env,
			PATH: `${tempRoot}${delimiter}${process.env.PATH}`,
			FAKE_GH_STATE: statePath,
			PILOOM_GH_BIN: toShellPath(fakeGhPath),
			PILOOM_JQ_BIN: toShellPath(fakeJqPath),
			GITHUB_REPOSITORY: "LiiLk/piloom",
			BETA_VERSION: "2.0.0-beta.1",
			BUILD_COMMIT: "newsha",
			BETA_DIR: toShellPath(betaDir),
			WINDOWS_DIR: toShellPath(windowsDir),
			INSTALLER_DIR: toShellPath(installerDir),
			BETA_NOTES_PATH: toShellPath(join(tempRoot, "notes.md")),
			PILOOM_BETA_FAILPOINT: failpoint,
			FAKE_GH_RELEASE_VIEW_ERROR: releaseViewErrorTag,
		},
		encoding: "utf8",
	});
	return { result, state: JSON.parse(readFileSync(statePath, "utf8")) };
};

const initialState = () => ({
	nextId: 10,
	refs: { beta: "oldsha" },
	releases: {
		beta: {
			id: "1", tagName: "beta", isDraft: false, isPrerelease: true, name: "Old Beta", body: "old notes\n",
			targetCommitish: "oldsha", assets: { "old-signed.tgz": "old signed bytes\n" },
		},
	},
});

const assert = (condition, message) => {
	if (!condition) throw new Error(message);
};

const unavailableSnapshot = run(initialState(), "", { releaseViewErrorTag: "beta" });
assert(unavailableSnapshot.result.status !== 0, "API error: publication unexpectedly continued");
assert(unavailableSnapshot.state.refs.beta === "oldsha", "API error: beta tag changed without a snapshot");
assert(unavailableSnapshot.state.releases.beta?.isDraft === false, "API error: public beta visibility changed");
assert(
	unavailableSnapshot.state.releases.beta?.assets?.["old-signed.tgz"] === "old signed bytes\n",
	"API error: old signed assets changed",
);
assert(!unavailableSnapshot.state.releases["beta-candidate"], "API error: candidate release was created");
assert(!unavailableSnapshot.state.releases["beta-backup"], "API error: backup release was created");
assert(
	unavailableSnapshot.result.stderr.includes("refusing to mutate release state"),
	"API error: fail-closed reason was not reported",
);

const failpoints = ["draft", "delete", "upload", "tag", "publish"];
for (const failpoint of failpoints) {
	const failed = run(initialState(), failpoint);
	assert(failed.result.status !== 0, `${failpoint}: failpoint unexpectedly succeeded`);
	assert(failed.state.refs.beta === "oldsha", `${failpoint}: beta tag was not restored`);
	assert(failed.state.releases.beta?.assets?.["old-signed.tgz"] === "old signed bytes\n", `${failpoint}: old assets were not restored`);
	assert(!failed.state.releases["beta-candidate"], `${failpoint}: candidate release leaked`);
	assert(!failed.state.releases["beta-backup"], `${failpoint}: backup release leaked`);

	const resumed = run(failed.state);
	assert(resumed.result.status === 0, `${failpoint}: retry failed: ${resumed.result.stderr}`);
	assert(resumed.state.refs.beta === "newsha", `${failpoint}: retry did not advance beta tag`);
	assert(resumed.state.releases.beta?.isDraft === false, `${failpoint}: retry left beta as draft`);
	assert(resumed.state.releases.beta?.assets?.["install-beta.sh"] === "new sh installer\n", `${failpoint}: retry assets missing`);
}

// Simulate a runner dying after old beta was renamed and the candidate was
// uploaded.  The next invocation must restore the backup before retrying.
const staleState = () => {
	const stale = initialState();
	stale.releases["beta-backup"] = { ...stale.releases.beta, id: "2", tagName: "beta-backup", isDraft: true };
	stale.releases["beta-candidate"] = {
		id: "3",
		tagName: "beta-candidate",
		isDraft: true,
		isPrerelease: true,
		name: "candidate",
		body: "candidate",
		targetCommitish: "newsha",
		assets: {},
	};
	delete stale.releases.beta;
	delete stale.refs.beta;
	stale.refs["beta-backup"] = "oldsha";
	stale.refs["beta-candidate"] = "newsha";
	return stale;
};
const recovered = run(staleState());
assert(recovered.result.status === 0, `stale transaction recovery failed: ${recovered.result.stderr}`);
assert(recovered.state.refs.beta === "newsha", "stale transaction did not publish the new beta");
assert(!recovered.state.releases["beta-backup"], "stale backup was not cleaned after success");
assert(!recovered.state.releases["beta-candidate"], "stale candidate was not cleaned");

for (const failpoint of failpoints) {
	const failedAfterRecovery = run(staleState(), failpoint);
	assert(failedAfterRecovery.result.status !== 0, `stale ${failpoint}: failpoint unexpectedly succeeded`);
	assert(failedAfterRecovery.state.refs.beta === "oldsha", `stale ${failpoint}: old beta tag was not restored`);
	assert(
		failedAfterRecovery.state.releases.beta?.isDraft === false,
		`stale ${failpoint}: old beta was not restored publicly`,
	);
	assert(
		failedAfterRecovery.state.releases.beta?.assets?.["old-signed.tgz"] === "old signed bytes\n",
		`stale ${failpoint}: old signed assets changed`,
	);
	assert(!failedAfterRecovery.state.releases["beta-candidate"], `stale ${failpoint}: candidate leaked`);
	assert(!failedAfterRecovery.state.releases["beta-backup"], `stale ${failpoint}: backup leaked`);
}

// Simulate a runner dying after the complete candidate was renamed to beta but
// before it was published. The old signed assets remain under beta-backup and
// must be restored before the retry starts.
const renamedCandidate = initialState();
renamedCandidate.releases["beta-backup"] = {
	...renamedCandidate.releases.beta,
	id: "2",
	tagName: "beta-backup",
	isDraft: true,
};
renamedCandidate.releases.beta = {
	id: "3",
	tagName: "beta",
	isDraft: true,
	isPrerelease: true,
	name: "Beta (v2.0.0-beta.1)",
	body: "candidate",
	targetCommitish: "newsha",
	assets: { "candidate.tgz": "candidate bytes\n" },
};
renamedCandidate.refs.beta = "newsha";
renamedCandidate.refs["beta-backup"] = "oldsha";
renamedCandidate.refs["beta-candidate"] = "newsha";
const recoveredRenamedCandidate = run(renamedCandidate);
assert(
	recoveredRenamedCandidate.result.status === 0,
	`renamed candidate recovery failed: ${recoveredRenamedCandidate.result.stderr}`,
);
assert(recoveredRenamedCandidate.state.refs.beta === "newsha", "renamed candidate recovery did not republish beta");
assert(
	recoveredRenamedCandidate.state.releases.beta?.assets?.["install-beta.sh"] === "new sh installer\n",
	"renamed candidate recovery did not publish the complete new asset set",
);
assert(
	!recoveredRenamedCandidate.state.releases["beta-backup"],
	"renamed candidate recovery left the backup release behind",
);
assert(
	!("beta-candidate" in recoveredRenamedCandidate.state.refs),
	"renamed candidate recovery leaked the candidate ref",
);

console.log(
	`Beta publication transaction checks passed (${failpoints.length} failpoints, fail-closed API errors, two stale-run recoveries, and stale recovery across every failpoint).`,
);
rmSync(tempRoot, { recursive: true, force: true });
