import { randomBytes } from "node:crypto";
import koffi from "koffi";

const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
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
