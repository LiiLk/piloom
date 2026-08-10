import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import koffi from "koffi";

const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS = 9;
const JOB_OBJECT_LIMIT_BREAKAWAY_OK = 0x00000800;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
const CREATE_NEW_PROCESS_GROUP = 0x00000200;
const CREATE_UNICODE_ENVIRONMENT = 0x00000400;
const CREATE_BREAKAWAY_FROM_JOB = 0x01000000;
const CREATE_NO_WINDOW = 0x08000000;
const CRYPTPROTECT_UI_FORBIDDEN = 0x1;
const FILE_CASE_SENSITIVE_INFORMATION_CLASS = 23;
const FILE_CS_FLAG_CASE_SENSITIVE_DIR = 0x00000001;
const FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
const FILE_READ_ATTRIBUTES = 0x00000080;
const FILE_SHARE_READ_WRITE_DELETE = 0x00000007;
const OPEN_EXISTING = 3;

interface DataBlobValue {
	cbData: number;
	pbData: unknown;
}

const kernel32 = process.platform === "win32" ? koffi.load("kernel32.dll") : undefined;
const crypt32 = process.platform === "win32" ? koffi.load("crypt32.dll") : undefined;

koffi.struct("PILOOM_DATA_BLOB", {
	cbData: "uint32",
	pbData: "uint8 *",
});

const IoCounters = koffi.struct("PILOOM_IO_COUNTERS", {
	ReadOperationCount: "uint64",
	WriteOperationCount: "uint64",
	OtherOperationCount: "uint64",
	ReadTransferCount: "uint64",
	WriteTransferCount: "uint64",
	OtherTransferCount: "uint64",
});

const BasicLimitInformation = koffi.struct("PILOOM_JOBOBJECT_BASIC_LIMIT_INFORMATION", {
	PerProcessUserTimeLimit: "int64",
	PerJobUserTimeLimit: "int64",
	LimitFlags: "uint32",
	MinimumWorkingSetSize: "uintptr",
	MaximumWorkingSetSize: "uintptr",
	ActiveProcessLimit: "uint32",
	Affinity: "uintptr",
	PriorityClass: "uint32",
	SchedulingClass: "uint32",
});

const ExtendedLimitInformation = koffi.struct("PILOOM_JOBOBJECT_EXTENDED_LIMIT_INFORMATION", {
	BasicLimitInformation,
	IoInfo: IoCounters,
	ProcessMemoryLimit: "uintptr",
	JobMemoryLimit: "uintptr",
	PeakProcessMemoryUsed: "uintptr",
	PeakJobMemoryUsed: "uintptr",
});

const FileCaseSensitiveInformation = koffi.struct("PILOOM_FILE_CASE_SENSITIVE_INFORMATION", {
	Flags: "uint32",
});

const StartupInfo = koffi.struct("PILOOM_STARTUPINFOW", {
	cb: "uint32",
	lpReserved: "void *",
	lpDesktop: "void *",
	lpTitle: "void *",
	dwX: "uint32",
	dwY: "uint32",
	dwXSize: "uint32",
	dwYSize: "uint32",
	dwXCountChars: "uint32",
	dwYCountChars: "uint32",
	dwFillAttribute: "uint32",
	dwFlags: "uint32",
	wShowWindow: "uint16",
	cbReserved2: "uint16",
	lpReserved2: "void *",
	hStdInput: "void *",
	hStdOutput: "void *",
	hStdError: "void *",
});

koffi.struct("PILOOM_PROCESS_INFORMATION", {
	hProcess: "void *",
	hThread: "void *",
	dwProcessId: "uint32",
	dwThreadId: "uint32",
});

const createJobObject = kernel32?.func("void * __stdcall CreateJobObjectW(void *, str16)");
const setInformationJobObject = kernel32?.func(
	"bool __stdcall SetInformationJobObject(void *, int32, PILOOM_JOBOBJECT_EXTENDED_LIMIT_INFORMATION *, uint32)",
);
const assignProcessToJobObject = kernel32?.func("bool __stdcall AssignProcessToJobObject(void *, void *)");
const getCurrentProcess = kernel32?.func("void * __stdcall GetCurrentProcess()");
const closeHandle = kernel32?.func("bool __stdcall CloseHandle(void *)");
const createFile = kernel32?.func(
	"void * __stdcall CreateFileW(str16, uint32, uint32, void *, uint32, uint32, void *)",
);
const getFileInformationByHandleEx = kernel32?.func(
	"bool __stdcall GetFileInformationByHandleEx(void *, int32, _Out_ PILOOM_FILE_CASE_SENSITIVE_INFORMATION *, uint32)",
);
const localFree = kernel32?.func("void * __stdcall LocalFree(void *)");
const createProcess = kernel32?.func(
	"bool __stdcall CreateProcessW(str16, void *, void *, void *, bool, uint32, void *, str16, PILOOM_STARTUPINFOW *, _Out_ PILOOM_PROCESS_INFORMATION *)",
);
const getLastError = kernel32?.func("uint32 __stdcall GetLastError()");
const cryptProtectData = crypt32?.func(
	"bool __stdcall CryptProtectData(PILOOM_DATA_BLOB *, str16, PILOOM_DATA_BLOB *, void *, void *, uint32, _Out_ PILOOM_DATA_BLOB *)",
);
const cryptUnprotectData = crypt32?.func(
	"bool __stdcall CryptUnprotectData(PILOOM_DATA_BLOB *, void *, PILOOM_DATA_BLOB *, void *, void *, uint32, _Out_ PILOOM_DATA_BLOB *)",
);

let processJobHandle: unknown;
let currentWindowsUserSid: string | undefined;

export function installWindowsKillOnCloseJob(options?: { allowExplicitBreakaway?: boolean }): boolean {
	if (process.platform !== "win32") {
		return false;
	}
	if (processJobHandle) {
		return true;
	}
	if (
		!createJobObject ||
		!setInformationJobObject ||
		!assignProcessToJobObject ||
		!getCurrentProcess ||
		!closeHandle
	) {
		return false;
	}

	const handle = createJobObject(null, null);
	if (!handle) {
		return false;
	}
	const limitFlags =
		JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE |
		(options?.allowExplicitBreakaway === true ? JOB_OBJECT_LIMIT_BREAKAWAY_OK : 0);
	if (!setWindowsJobLimitFlags(handle, limitFlags)) {
		closeHandle(handle);
		return false;
	}
	if (!assignProcessToJobObject(handle, getCurrentProcess())) {
		closeHandle(handle);
		return false;
	}

	processJobHandle = handle;
	return true;
}

function quoteWindowsProcessArgument(value: string): string {
	if (value.includes("\0")) throw new Error("Windows process arguments cannot contain NUL characters");
	if (value.length > 0 && !/[\s"]/u.test(value)) return value;
	let result = '"';
	let backslashes = 0;
	for (const character of value) {
		if (character === "\\") {
			backslashes++;
			continue;
		}
		if (character === '"') {
			result += "\\".repeat(backslashes * 2 + 1);
			result += character;
			backslashes = 0;
			continue;
		}
		result += "\\".repeat(backslashes);
		result += character;
		backslashes = 0;
	}
	result += "\\".repeat(backslashes * 2);
	return `${result}"`;
}

function createWindowsEnvironmentBlock(environment: NodeJS.ProcessEnv): Buffer {
	const entries = Object.entries(environment)
		.filter((entry): entry is [string, string] => entry[1] !== undefined)
		.sort(([left], [right]) => left.toLowerCase().localeCompare(right.toLowerCase()));
	for (const [name, value] of entries) {
		if (name.includes("\0") || value.includes("\0")) {
			throw new Error("Windows process environment cannot contain NUL characters");
		}
	}
	return Buffer.from(`${entries.map(([name, value]) => `${name}=${value}`).join("\0")}\0\0`, "utf16le");
}

export function spawnDetachedWindowsProcess(options: {
	command: string;
	args: readonly string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
}): number {
	if (process.platform !== "win32" || !createProcess || !closeHandle) {
		throw new Error("Windows detached process creation is unavailable");
	}
	const commandLine = Buffer.from(
		`${[options.command, ...options.args].map(quoteWindowsProcessArgument).join(" ")}\0`,
		"utf16le",
	);
	const environmentBlock = createWindowsEnvironmentBlock(options.env);
	const startupInfo = {
		cb: koffi.sizeof(StartupInfo),
		lpReserved: null,
		lpDesktop: null,
		lpTitle: null,
		dwX: 0,
		dwY: 0,
		dwXSize: 0,
		dwYSize: 0,
		dwXCountChars: 0,
		dwYCountChars: 0,
		dwFillAttribute: 0,
		dwFlags: 0,
		wShowWindow: 0,
		cbReserved2: 0,
		lpReserved2: null,
		hStdInput: null,
		hStdOutput: null,
		hStdError: null,
	};
	const processInformation = { hProcess: null, hThread: null, dwProcessId: 0, dwThreadId: 0 };
	const creationFlags =
		CREATE_BREAKAWAY_FROM_JOB | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT;
	if (
		!createProcess(
			options.command,
			commandLine,
			null,
			null,
			false,
			creationFlags,
			environmentBlock,
			options.cwd,
			startupInfo,
			processInformation,
		)
	) {
		throw new Error(`CreateProcessW failed with Win32 error ${getLastError?.() ?? "unknown"}`);
	}
	closeHandle(processInformation.hThread);
	closeHandle(processInformation.hProcess);
	return processInformation.dwProcessId;
}

function setWindowsJobLimitFlags(handle: unknown, limitFlags: number): boolean {
	if (!setInformationJobObject) {
		return false;
	}
	const information = {
		BasicLimitInformation: {
			PerProcessUserTimeLimit: 0,
			PerJobUserTimeLimit: 0,
			LimitFlags: limitFlags,
			MinimumWorkingSetSize: 0,
			MaximumWorkingSetSize: 0,
			ActiveProcessLimit: 0,
			Affinity: 0,
			PriorityClass: 0,
			SchedulingClass: 0,
		},
		IoInfo: {
			ReadOperationCount: 0,
			WriteOperationCount: 0,
			OtherOperationCount: 0,
			ReadTransferCount: 0,
			WriteTransferCount: 0,
			OtherTransferCount: 0,
		},
		ProcessMemoryLimit: 0,
		JobMemoryLimit: 0,
		PeakProcessMemoryUsed: 0,
		PeakJobMemoryUsed: 0,
	};

	return Boolean(
		setInformationJobObject(
			handle,
			JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
			information,
			koffi.sizeof(ExtendedLimitInformation),
		),
	);
}

export function createWindowsAuthenticationToken(): string {
	return randomBytes(32).toString("base64url");
}

export function parseWindowsWhoamiSid(output: string): string | undefined {
	return output.match(/\bS-\d(?:-\d+)+\b/i)?.[0];
}

export function getWindowsCurrentUserSid(): string {
	if (process.platform !== "win32") throw new Error("Windows user SID is only available on Windows");
	if (currentWindowsUserSid) return currentWindowsUserSid;
	const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR;
	if (!windowsRoot || !isAbsolute(windowsRoot)) {
		throw new Error("Cannot isolate the daemon pipe because SystemRoot is unavailable");
	}
	const whoami = join(windowsRoot, "System32", "whoami.exe");
	if (!existsSync(whoami)) {
		throw new Error(`Cannot isolate the daemon pipe because ${whoami} is unavailable`);
	}
	const result = spawnSync(whoami, ["/user", "/fo", "csv", "/nh"], {
		encoding: "utf8",
		timeout: 5000,
		windowsHide: true,
	});
	const sid = result.status === 0 ? parseWindowsWhoamiSid(result.stdout) : undefined;
	if (!sid) {
		throw new Error("Cannot isolate the daemon pipe because the current Windows user SID could not be read");
	}
	currentWindowsUserSid = sid;
	return sid;
}

export function windowsDaemonUserKey(sid: string): string {
	if (!/^S-\d(?:-\d+)+$/i.test(sid)) throw new Error("Invalid Windows user SID");
	return createHash("sha256").update(sid.toUpperCase()).digest("hex").slice(0, 24);
}

export function isWindowsDirectoryCaseSensitive(directory: string): boolean {
	if (process.platform !== "win32" || !createFile || !getFileInformationByHandleEx || !closeHandle) {
		return false;
	}
	const handle = createFile(
		directory,
		FILE_READ_ATTRIBUTES,
		FILE_SHARE_READ_WRITE_DELETE,
		null,
		OPEN_EXISTING,
		FILE_FLAG_BACKUP_SEMANTICS,
		null,
	);
	if (!handle) {
		return false;
	}
	try {
		const information = { Flags: 0 };
		return (
			Boolean(
				getFileInformationByHandleEx(
					handle,
					FILE_CASE_SENSITIVE_INFORMATION_CLASS,
					information,
					koffi.sizeof(FileCaseSensitiveInformation),
				),
			) && (information.Flags & FILE_CS_FLAG_CASE_SENSITIVE_DIR) !== 0
		);
	} finally {
		closeHandle(handle);
	}
}

export function protectWindowsData(value: Buffer, entropy: Buffer): string {
	return transformWindowsData(value, entropy, cryptProtectData).toString("base64");
}

export function unprotectWindowsData(value: string, entropy: Buffer): Buffer {
	return transformWindowsData(Buffer.from(value, "base64"), entropy, cryptUnprotectData);
}

function transformWindowsData(value: Buffer, entropy: Buffer, transform: typeof cryptProtectData): Buffer {
	if (process.platform !== "win32" || !transform || !localFree) {
		throw new Error("Windows data protection is unavailable");
	}
	const input: DataBlobValue = { cbData: value.byteLength, pbData: value };
	const optionalEntropy: DataBlobValue = { cbData: entropy.byteLength, pbData: entropy };
	const output: DataBlobValue = { cbData: 0, pbData: null };
	if (!transform(input, null, optionalEntropy, null, null, CRYPTPROTECT_UI_FORBIDDEN, output)) {
		throw new Error("Windows data protection failed");
	}
	try {
		return Buffer.from(koffi.decode(output.pbData, "uint8", output.cbData) as Uint8Array);
	} finally {
		localFree(output.pbData);
	}
}
