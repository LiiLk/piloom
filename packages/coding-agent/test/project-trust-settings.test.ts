import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DefaultPackageManager } from "../src/core/package-manager.js";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.js";

describe("project trust settings barrier", () => {
	it("does not parse or expose project settings until trusted", () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("project", () => "{malformed");
		const manager = SettingsManager.fromStorage(storage, { projectTrusted: false });
		expect(manager.isProjectTrusted()).toBe(false);
		expect(manager.getProjectSettings()).toEqual({});
		expect(manager.getExtensionPaths()).toEqual([]);
		manager.setProjectTrusted(true);
		expect(manager.drainErrors("project")).toHaveLength(1);
	});

	it("refuses project writes while untrusted", async () => {
		const storage = new InMemorySettingsStorage();
		const manager = SettingsManager.fromStorage(storage, { projectTrusted: false });
		expect(() => manager.setProjectExtensionPaths(["./extension.js"])).toThrow(/not trusted/);
		await manager.flush();
	});

	it("refuses direct project package storage access while untrusted", async () => {
		const root = join(tmpdir(), `project-trust-packages-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		try {
			const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
			const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
			expect(() => packageManager.getInstalledPath(".", "project")).toThrow(/not trusted/);
			await expect(packageManager.install(".", { local: true })).rejects.toThrow(/not trusted/);
			await expect(packageManager.remove(".", { local: true })).rejects.toThrow(/not trusted/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not discover project extensions or skills before trust", async () => {
		const root = join(tmpdir(), `project-trust-resources-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		const extensionPath = join(cwd, ".prime", "agent", "extensions", "unsafe.ts");
		const skillPath = join(cwd, ".agents", "skills", "unsafe", "SKILL.md");
		mkdirSync(dirname(extensionPath), { recursive: true });
		mkdirSync(dirname(skillPath), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(extensionPath, "throw new Error('must not load before trust')");
		writeFileSync(skillPath, "---\nname: unsafe\ndescription: unsafe\n---\n");
		try {
			const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
			const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
			const untrusted = await packageManager.resolve();
			expect(untrusted.extensions.map((entry) => resolve(entry.path))).not.toContain(resolve(extensionPath));
			expect(untrusted.skills.map((entry) => resolve(entry.path))).not.toContain(resolve(skillPath));

			settingsManager.setProjectTrusted(true);
			await settingsManager.reload();
			const trusted = await packageManager.resolve();
			expect(trusted.extensions.map((entry) => resolve(entry.path))).toContain(resolve(extensionPath));
			expect(trusted.skills.map((entry) => resolve(entry.path))).toContain(resolve(skillPath));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
