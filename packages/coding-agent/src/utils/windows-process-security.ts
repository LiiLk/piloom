import { randomBytes } from "node:crypto";
import koffi from "koffi";

const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
const CRYPTPROTECT_UI_FORBIDDEN = 0x1;

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

const createJobObject = kernel32?.func("void * __stdcall CreateJobObjectW(void *, str16)");
const setInformationJobObject = kernel32?.func(
	"bool __stdcall SetInformationJobObject(void *, int32, PILOOM_JOBOBJECT_EXTENDED_LIMIT_INFORMATION *, uint32)",
);
const assignProcessToJobObject = kernel32?.func("bool __stdcall AssignProcessToJobObject(void *, void *)");
const getCurrentProcess = kernel32?.func("void * __stdcall GetCurrentProcess()");
const closeHandle = kernel32?.func("bool __stdcall CloseHandle(void *)");
const localFree = kernel32?.func("void * __stdcall LocalFree(void *)");
const cryptProtectData = crypt32?.func(
	"bool __stdcall CryptProtectData(PILOOM_DATA_BLOB *, str16, PILOOM_DATA_BLOB *, void *, void *, uint32, _Out_ PILOOM_DATA_BLOB *)",
);
const cryptUnprotectData = crypt32?.func(
	"bool __stdcall CryptUnprotectData(PILOOM_DATA_BLOB *, void *, PILOOM_DATA_BLOB *, void *, void *, uint32, _Out_ PILOOM_DATA_BLOB *)",
);

let processJobHandle: unknown;

export function installWindowsKillOnCloseJob(): boolean {
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
	if (!setWindowsJobLimitFlags(handle, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)) {
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
