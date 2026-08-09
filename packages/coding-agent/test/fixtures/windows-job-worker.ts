import { spawn } from "node:child_process";
import { installWindowsKillOnCloseJob } from "../../src/utils/windows-process-security.js";

if (!installWindowsKillOnCloseJob()) {
	throw new Error("Unable to install the Windows kill-on-close Job Object");
}

const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
	stdio: "ignore",
	windowsHide: true,
});
if (!child.pid) {
	throw new Error("Child process did not expose a PID");
}

process.stdout.write(`${JSON.stringify({ childPid: child.pid })}\n`);
setInterval(() => {}, 1000);
