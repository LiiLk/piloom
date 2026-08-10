import { spawn } from "node:child_process";
import { installWindowsKillOnCloseJob, spawnDetachedWindowsProcess } from "../../src/utils/windows-process-security.js";

const launchBreakawayChild = process.env.PILOOM_TEST_BREAKAWAY === "1";
if (!installWindowsKillOnCloseJob({ allowExplicitBreakaway: launchBreakawayChild })) {
	throw new Error("Unable to install the Windows kill-on-close Job Object");
}

const childPid = launchBreakawayChild
	? spawnDetachedWindowsProcess({
			command: process.execPath,
			args: ["-e", "setInterval(() => {}, 1000)"],
			cwd: process.cwd(),
			env: process.env,
		})
	: spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			stdio: "ignore",
			windowsHide: true,
		}).pid;
if (!childPid) {
	throw new Error("Child process did not expose a PID");
}

process.stdout.write(`${JSON.stringify({ childPid })}\n`);
setInterval(() => {}, 1000);
