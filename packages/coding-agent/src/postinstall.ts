import { ensureKernelPython } from "./core/kernel/bootstrap.js";
import { ensureTool } from "./utils/tools-manager.js";

const bootstrapKernel = process.env.PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL === "1";
const bootstrapTools = process.env.PRIME_AGENT_BOOTSTRAP_TOOLS_ON_INSTALL === "1";

if (!bootstrapKernel && !bootstrapTools) {
	process.exit(0);
}

if (bootstrapKernel && process.env.PRIME_AGENT_INSTALL_UV === undefined) {
	process.env.PRIME_AGENT_INSTALL_UV = "1";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function oneLine(message: string): string {
	return message.replace(/\s+/g, " ").trim();
}

try {
	if (bootstrapTools) {
		await Promise.all([ensureTool("fd", true), ensureTool("rg", true)]);
	}
	if (bootstrapKernel) {
		await ensureKernelPython();
	}
} catch (error) {
	// This only warms up the search tools and the IPython runtime; both are
	// bootstrapped again on first use. Failing here would abort an otherwise
	// working `npm install --global` over a transient download error.
	console.error(`prime-agent: postinstall setup failed, it will run again on first use.`);
	console.error(`prime-agent: ${oneLine(errorMessage(error))}`);
}
