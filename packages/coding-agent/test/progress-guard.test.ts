import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createProgressGuard, extractFileAccesses, PROGRESS_GUARD_BLOCK_PREFIX } from "../src/core/progress-guard.js";

function writeRepo(): { cwd: string; app: string; ws: string } {
	const cwd = mkdtempSync(join(tmpdir(), "progress-guard-"));
	mkdirSync(join(cwd, "src", "assistant"), { recursive: true });
	mkdirSync(join(cwd, "src", "server"), { recursive: true });
	const app = join(cwd, "src", "assistant", "app.py");
	const ws = join(cwd, "src", "server", "websocket.py");
	writeFileSync(app, "print('app')\n");
	writeFileSync(ws, "print('ws')\n");
	return { cwd, app, ws };
}

function ipython(code: string): { code: string } {
	return { code };
}

describe("extractFileAccesses", () => {
	it("extracts Path / root joins and print_range slices from IPython cells", () => {
		const cwd = "C:/repo";
		expect(
			extractFileAccesses("ipython", ipython("(root/'src/assistant/app.py').read_text()"), cwd).map(
				(access) => access.relPath,
			),
		).toEqual(["src/assistant/app.py"]);

		expect(extractFileAccesses("ipython", ipython("print_range('src/server/websocket.py', 1, 430)"), cwd)).toEqual([
			{ relPath: "src/server/websocket.py", start: 1, end: 430, kind: "read" },
		]);

		expect(
			extractFileAccesses(
				"ipython",
				ipython("await edit(path='src/assistant/app.py', old_str='a', new_str='b')"),
				cwd,
			),
		).toEqual([{ relPath: "src/assistant/app.py", kind: "mutate" }]);
	});

	it("classifies reads, mutations, and harness calls separately", () => {
		const cwd = "C:/repo";
		expect(extractFileAccesses("ipython", ipython("(root/'src/assistant/app.py').read_text()"), cwd)).toEqual([
			{ relPath: "src/assistant/app.py", kind: "read" },
		]);
		expect(extractFileAccesses("ipython", ipython("(root/'src/assistant/app.py').write_text('x')"), cwd)).toEqual([
			{ relPath: "src/assistant/app.py", kind: "mutate" },
		]);
		expect(
			extractFileAccesses("ipython", ipython("await rlm('Inspect src/assistant/app.py and summarize')"), cwd),
		).toEqual([]);
		expect(
			extractFileAccesses("edit", { path: "src/assistant/app.py", edits: [{ oldText: "a", newText: "b" }] }, cwd),
		).toEqual([{ relPath: "src/assistant/app.py", kind: "mutate" }]);
		expect(extractFileAccesses("ipython", ipython("%%bash\ncat src/assistant/app.py\n"), cwd)).toEqual([
			{ relPath: "src/assistant/app.py", kind: "read" },
		]);
		expect(extractFileAccesses("ipython", ipython("%%bash\nsed -i 's/a/b/' src/assistant/app.py\n"), cwd)).toEqual([
			{ relPath: "src/assistant/app.py", kind: "mutate" },
		]);
	});

	it("ignores encodings, URLs, and pytest node ids", () => {
		const accesses = extractFileAccesses(
			"ipython",
			ipython("p.read_text(encoding='utf-8', errors='replace'); url='https://example.com/app.py'"),
			"/tmp",
		);
		expect(accesses).toEqual([]);

		expect(
			extractFileAccesses("ipython", ipython("cmd=['pytest', 'tests/test_audio_service.py::test_audio']"), "/tmp"),
		).toEqual([]);
	});
});

describe("createProgressGuard", () => {
	it("allows two unchanged reads of the same file and blocks the third", () => {
		const { cwd } = writeRepo();
		const guard = createProgressGuard({ cwd, maxRepeats: 2 });
		const args = ipython("(root/'src/assistant/app.py').read_text(encoding='utf-8')");

		expect(guard.evaluate("ipython", args).block).toBe(false);
		guard.record("ipython", args);
		expect(guard.evaluate("ipython", args).block).toBe(false);
		guard.record("ipython", args);

		const third = guard.evaluate("ipython", args);
		expect(third.block).toBe(true);
		if (!third.block) {
			throw new Error("expected block");
		}
		expect(third.reason).toContain(PROGRESS_GUARD_BLOCK_PREFIX);
		expect(third.reason).toContain("src/assistant/app.py");
	});

	it("treats different wrapping code that rereads the same file as the same access", () => {
		const { cwd } = writeRepo();
		const guard = createProgressGuard({ cwd });

		const first = ipython("print((root/'src/assistant/app.py').read_text())");
		const second = ipython(
			"for i,l in enumerate((root/'src/assistant/app.py').read_text(encoding='utf-8',errors='replace').splitlines(),1):\n print(i,l)",
		);

		guard.record("ipython", first);
		guard.record("ipython", second);
		expect(guard.evaluate("ipython", second).block).toBe(true);
	});

	it("allows a new slice of the same file and blocks a repeated slice", () => {
		const { cwd } = writeRepo();
		const guard = createProgressGuard({ cwd });
		const firstSlice = ipython("print_range('src/server/websocket.py', 1, 430)");
		const secondSlice = ipython("print_range('src/server/websocket.py', 430, 800)");

		guard.record("ipython", firstSlice);
		expect(guard.evaluate("ipython", secondSlice).block).toBe(false);
		guard.record("ipython", secondSlice);
		expect(guard.evaluate("ipython", firstSlice).block).toBe(false);
		guard.record("ipython", firstSlice);
		expect(guard.evaluate("ipython", firstSlice).block).toBe(true);
	});

	it("resets the counter when the file contents change", () => {
		const { cwd, app } = writeRepo();
		const guard = createProgressGuard({ cwd });
		const args = ipython("(root/'src/assistant/app.py').read_text()");

		guard.record("ipython", args);
		guard.record("ipython", args);
		expect(guard.evaluate("ipython", args).block).toBe(true);

		writeFileSync(app, "print('app changed')\n");
		expect(guard.evaluate("ipython", args).block).toBe(false);
	});

	it("does not block a cell that also reads a file that still has new coverage", () => {
		const { cwd } = writeRepo();
		const guard = createProgressGuard({ cwd });
		const appOnly = ipython("(root/'src/assistant/app.py').read_text()");
		guard.record("ipython", appOnly);
		guard.record("ipython", appOnly);

		const mixed = ipython("(root/'src/assistant/app.py').read_text(); (root/'src/server/websocket.py').read_text()");
		expect(guard.evaluate("ipython", mixed).block).toBe(false);
	});

	it("does not count tools that mention no existing project files", () => {
		const { cwd } = writeRepo();
		const guard = createProgressGuard({ cwd });
		const args = ipython("print(2 + 2)");
		guard.record("ipython", args);
		guard.record("ipython", args);
		expect(guard.evaluate("ipython", args).block).toBe(false);
	});

	it("does not block an edit or write after two unchanged reads", () => {
		const { cwd } = writeRepo();
		const guard = createProgressGuard({ cwd });
		const read = ipython("(root/'src/assistant/app.py').read_text()");
		guard.record("ipython", read);
		guard.record("ipython", read);
		expect(guard.evaluate("ipython", read).block).toBe(true);

		expect(
			guard.evaluate("ipython", ipython("await edit(path='src/assistant/app.py', old_str='print', new_str='print')"))
				.block,
		).toBe(false);
		expect(guard.evaluate("ipython", ipython("(root/'src/assistant/app.py').write_text('changed')")).block).toBe(
			false,
		);
		expect(
			guard.evaluate("edit", { path: "src/assistant/app.py", edits: [{ oldText: "a", newText: "b" }] }).block,
		).toBe(false);
		expect(
			guard.evaluate("ipython", ipython("!edit --path src/assistant/app.py --old-str a --new-str b")).block,
		).toBe(false);
	});

	it("resets coverage after a recorded mutation so a later read is allowed", () => {
		const { cwd } = writeRepo();
		const guard = createProgressGuard({ cwd });
		const read = ipython("(root/'src/assistant/app.py').read_text()");
		guard.record("ipython", read);
		guard.record("ipython", read);
		expect(guard.evaluate("ipython", read).block).toBe(true);

		guard.record("ipython", ipython("await edit(path='src/assistant/app.py', old_str='a', new_str='b')"));
		expect(guard.evaluate("ipython", read).block).toBe(false);
	});

	it("does not treat rlm or agent_message prompts as file reads", () => {
		const { cwd } = writeRepo();
		const guard = createProgressGuard({ cwd });
		const spawn = ipython("await rlm('Inspect src/assistant/app.py and src/server/websocket.py')");
		guard.record("ipython", spawn);
		guard.record("ipython", spawn);
		expect(guard.evaluate("ipython", spawn).block).toBe(false);

		const read = ipython("(root/'src/assistant/app.py').read_text()");
		guard.record("ipython", read);
		guard.record("ipython", read);
		expect(guard.evaluate("ipython", spawn).block).toBe(false);
		expect(guard.evaluate("ipython", read).block).toBe(true);
	});

	it("allows a mixed edit+read cell and still blocks a pure reread", () => {
		const { cwd } = writeRepo();
		const guard = createProgressGuard({ cwd });
		const read = ipython("(root/'src/assistant/app.py').read_text()");
		guard.record("ipython", read);
		guard.record("ipython", read);

		const mixed = ipython(
			"(root/'src/assistant/app.py').read_text(); await edit(path='src/assistant/app.py', old_str='a', new_str='b')",
		);
		expect(guard.evaluate("ipython", mixed).block).toBe(false);
		expect(guard.evaluate("ipython", read).block).toBe(true);
	});

	it("treats bash cat as a read and bash redirects as mutations", () => {
		const { cwd } = writeRepo();
		const guard = createProgressGuard({ cwd });
		const read = ipython("(root/'src/assistant/app.py').read_text()");
		guard.record("ipython", read);
		guard.record("ipython", read);

		expect(guard.evaluate("ipython", ipython("%%bash\ncat src/assistant/app.py\n")).block).toBe(true);
		expect(guard.evaluate("bash", { command: "cat src/assistant/app.py" }).block).toBe(true);
		expect(guard.evaluate("bash", { command: "echo x > src/assistant/app.py" }).block).toBe(false);
		guard.record("bash", { command: "echo x > src/assistant/app.py" });
		expect(guard.evaluate("ipython", read).block).toBe(false);
	});

	it("can be disabled", () => {
		const { cwd } = writeRepo();
		const guard = createProgressGuard({ cwd, enabled: false });
		const args = ipython("(root/'src/assistant/app.py').read_text()");
		guard.record("ipython", args);
		guard.record("ipython", args);
		expect(guard.evaluate("ipython", args).block).toBe(false);
	});
});
