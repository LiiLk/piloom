import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe.skipIf(process.platform !== "win32")("Windows Job Object cleanup", () => {
	it("kills a worker's inherited child when the worker is forcibly terminated", async () => {
		const fixture = resolve(__dirname, "fixtures/windows-job-worker.ts");
		const tsxCli = resolve(__dirname, "../../../node_modules/tsx/dist/cli.mjs");
		const worker = spawn(process.execPath, [tsxCli, fixture], {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let childPid: number | undefined;
		try {
			const line = await readFirstLine(worker.stdout);
			childPid = (JSON.parse(line) as { childPid: number }).childPid;
			expect(isProcessAlive(childPid)).toBe(true);

			process.kill(worker.pid!);
			await waitForExit(worker);
			await waitUntil(() => !isProcessAlive(childPid!), 5000);
			expect(isProcessAlive(childPid)).toBe(false);
		} finally {
			if (worker.pid && isProcessAlive(worker.pid)) {
				spawnSync("taskkill.exe", ["/pid", String(worker.pid), "/t", "/f"], { windowsHide: true });
			}
			if (childPid && isProcessAlive(childPid)) {
				spawnSync("taskkill.exe", ["/pid", String(childPid), "/t", "/f"], { windowsHide: true });
			}
		}
	}, 15_000);
});

function readFirstLine(stream: NodeJS.ReadableStream): Promise<string> {
	return new Promise((resolveLine, reject) => {
		let buffered = "";
		const onData = (chunk: Buffer | string) => {
			buffered += chunk.toString();
			const newline = buffered.indexOf("\n");
			if (newline < 0) return;
			cleanup();
			resolveLine(buffered.slice(0, newline));
		};
		const onEnd = () => {
			cleanup();
			reject(new Error("Worker exited before reporting its child PID"));
		};
		const cleanup = () => {
			stream.off("data", onData);
			stream.off("end", onEnd);
		};
		stream.on("data", onData);
		stream.on("end", onEnd);
	});
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
	if (child.exitCode !== null) return Promise.resolve();
	return new Promise((resolveExit, reject) => {
		child.once("exit", () => resolveExit());
		child.once("error", reject);
	});
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(`Condition not met within ${timeoutMs}ms`);
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
	}
}
