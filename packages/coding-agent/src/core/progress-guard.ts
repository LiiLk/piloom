import { statSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { parseIpythonBashCell } from "./tools/ipython-cell-code.js";
import { resolveToCwd } from "./tools/path-utils.js";

export const PROGRESS_GUARD_BLOCK_PREFIX = "Repeated file access blocked:";

const DEFAULT_MAX_REPEATS = 2;
const SOURCE_FILE_EXT =
	/\.(?:py|ts|tsx|js|jsx|mjs|cjs|md|json|jsonl|ya?ml|toml|txt|html?|css|scss|rs|go|java|kt|c|cc|cpp|h|hpp|cs|rb|php|sh|ps1|sql|xml|svg|vue|svelte|ini|cfg|conf|env|lock|ipynb)$/i;
const QUOTED_STRING_RE = /(?:r)?(['"])([^'"\n]{3,240})\1/gi;
const TOKEN_RE = /\S+/g;
const IGNORE_CALLEE_RE =
	/\b(?:await\s+)?(?:rlm(?:\.\w+)*|refine(?:\.\w+)*|agent_message(?:\.\w+)*|agent_observe(?:\.\w+)*|compact(?:\.\w+)*|rlm_heartbeat(?:\.\w+)*|attach_image)\s*\(/g;
const MUTATE_CALLEE_RE = /\b(?:await\s+)?edit\s*\(/g;
const READ_API_RE = /\.read_(?:text|bytes)\s*\(|\bprint_range\s*\(|\bshow\s*\(/;
const BASH_READ_RE = /\b(?:cat|head|tail|less|more|type|bat|nl)\b/;
const BASH_MUTATE_CMD_RE = /\b(?:rm|tee|truncate|touch)\b/;

export type FileAccessKind = "read" | "mutate";

export interface ProgressGuardSettings {
	enabled?: boolean;
	maxRepeats?: number;
}

export interface ExtractedFileAccess {
	relPath: string;
	kind: FileAccessKind;
	start?: number;
	end?: number;
}

export interface ProgressGuardDecision {
	block: boolean;
	reason?: string;
}

export interface ProgressGuard {
	evaluate(toolName: string, args: unknown): ProgressGuardDecision;
	record(toolName: string, args: unknown): void;
}

interface ResolvedSettings {
	enabled: boolean;
	maxRepeats: number;
}

interface ProgressGuardOptions {
	cwd: string;
	enabled?: boolean;
	maxRepeats?: number;
	settings?: () => ProgressGuardSettings;
}

interface LineRange {
	start: number;
	end: number;
}

interface FileCoverage {
	identity: string;
	covered: LineRange[];
	noProgressCount: number;
}

interface PathLiteral {
	raw: string;
	index: number;
	length: number;
}

interface Span {
	start: number;
	end: number;
}

const FULL_RANGE: LineRange = { start: 1, end: Number.POSITIVE_INFINITY };

export function normalizeProgressGuardSettings(settings?: ProgressGuardSettings): ResolvedSettings {
	const maxRepeats = settings?.maxRepeats;
	return {
		enabled: settings?.enabled ?? true,
		maxRepeats:
			typeof maxRepeats === "number" && Number.isFinite(maxRepeats) && maxRepeats >= 1
				? Math.trunc(maxRepeats)
				: DEFAULT_MAX_REPEATS,
	};
}

export function extractFileAccesses(toolName: string, args: unknown, cwd: string): ExtractedFileAccess[] {
	const found = new Map<string, ExtractedFileAccess>();
	const add = (access: ExtractedFileAccess) => {
		const key = `${access.kind}\0${access.relPath}\0${access.start ?? ""}\0${access.end ?? ""}`;
		if (!found.has(key)) {
			found.set(key, access);
		}
	};

	if (toolName === "edit") {
		const path = pathArg(args);
		if (path && isFilePathLiteral(path)) {
			add({ relPath: toPosixRelPath(path, cwd), kind: "mutate" });
		}
	}

	const text = collectArgText(args);
	if (!text) {
		return [...found.values()];
	}

	const bashCell = toolName === "ipython" ? parseIpythonBashCell(text) : undefined;
	if (toolName === "bash" || bashCell) {
		for (const access of extractBashAccesses(bashCell?.body ?? text, cwd)) {
			add(access);
		}
		return [...found.values()];
	}

	for (const access of extractPythonAccesses(text, cwd)) {
		add(access);
	}
	return [...found.values()];
}

export function createProgressGuard(options: ProgressGuardOptions): ProgressGuard {
	const coverage = new Map<string, FileCoverage>();

	const resolveSettings = (): ResolvedSettings => {
		if (options.settings) {
			return normalizeProgressGuardSettings(options.settings());
		}
		return normalizeProgressGuardSettings({
			enabled: options.enabled,
			maxRepeats: options.maxRepeats,
		});
	};

	const resolveAccesses = (toolName: string, args: unknown) => {
		const resolved: Array<{
			absPath: string;
			relPath: string;
			range: LineRange;
			identity: string;
			kind: FileAccessKind;
		}> = [];
		for (const access of extractFileAccesses(toolName, args, options.cwd)) {
			const absPath = resolveToCwd(access.relPath, options.cwd);
			const identity = fileIdentity(absPath);
			if (!identity) {
				continue;
			}
			resolved.push({
				absPath,
				relPath: access.relPath,
				range: toRange(access),
				identity,
				kind: access.kind,
			});
		}
		return resolved;
	};

	return {
		evaluate(toolName, args) {
			const settings = resolveSettings();
			if (!settings.enabled) {
				return { block: false };
			}
			const accesses = resolveAccesses(toolName, args);
			if (accesses.some((access) => access.kind === "mutate")) {
				return { block: false };
			}
			const reads = accesses.filter((access) => access.kind === "read");
			if (reads.length === 0) {
				return { block: false };
			}

			const blocked: string[] = [];
			for (const access of reads) {
				const state = coverage.get(access.absPath);
				if (!isExhausted(state, access.identity, access.range, settings.maxRepeats)) {
					return { block: false };
				}
				blocked.push(access.relPath);
			}

			const listed = [...new Set(blocked)].join(", ");
			return {
				block: true,
				reason:
					`${PROGRESS_GUARD_BLOCK_PREFIX} ${listed} ` +
					`already read ${settings.maxRepeats} times with unchanged contents. ` +
					`Use the data you already have, or inspect a different file.`,
			};
		},

		record(toolName, args) {
			const settings = resolveSettings();
			if (!settings.enabled) {
				return;
			}
			const accesses = resolveAccesses(toolName, args);
			const mutated = new Set(accesses.filter((access) => access.kind === "mutate").map((access) => access.absPath));
			for (const access of accesses) {
				if (access.kind !== "read" || mutated.has(access.absPath)) {
					continue;
				}
				const previous = coverage.get(access.absPath);
				if (!previous || previous.identity !== access.identity) {
					coverage.set(access.absPath, {
						identity: access.identity,
						covered: [access.range],
						noProgressCount: 0,
					});
					continue;
				}
				if (isSubset(access.range, previous.covered)) {
					previous.noProgressCount += 1;
					continue;
				}
				previous.covered.push(access.range);
				previous.noProgressCount = 0;
			}
			for (const absPath of mutated) {
				coverage.delete(absPath);
			}
		},
	};
}

function extractPythonAccesses(code: string, cwd: string): ExtractedFileAccess[] {
	const ignoreSpans = callSpans(code, IGNORE_CALLEE_RE);
	const mutateSpans = callSpans(code, MUTATE_CALLEE_RE);
	const literals = extractPathLiterals(code);
	const classified: ExtractedFileAccess[] = [];
	const unclassified: PathLiteral[] = [];

	for (const literal of literals) {
		if (inSpans(literal.index, ignoreSpans)) {
			continue;
		}
		const kind = classifyPythonLiteral(code, literal, mutateSpans);
		if (kind === "unclassified") {
			unclassified.push(literal);
			continue;
		}
		if (kind === "ignore") {
			continue;
		}
		classified.push(toAccess(literal, kind, code, cwd));
	}

	if (READ_API_RE.test(code)) {
		for (const literal of unclassified) {
			classified.push(toAccess(literal, "read", code, cwd));
		}
	}

	return classified;
}

function extractBashAccesses(command: string, cwd: string): ExtractedFileAccess[] {
	const accesses: ExtractedFileAccess[] = [];
	for (const literal of extractPathLiterals(command)) {
		const kind = classifyBashLiteral(command, literal.raw);
		if (!kind) {
			continue;
		}
		accesses.push({ relPath: toPosixRelPath(literal.raw, cwd), kind });
	}
	return accesses;
}

function classifyPythonLiteral(
	code: string,
	literal: PathLiteral,
	mutateSpans: Span[],
): FileAccessKind | "ignore" | "unclassified" {
	const start = literal.index;
	const end = literal.index + literal.length;
	if (inSpans(start, mutateSpans)) {
		return "mutate";
	}

	const after = code.slice(end, end + 80);
	const before = code.slice(Math.max(0, start - 140), start);

	if (
		/\.write_(?:text|bytes)\s*\(/.test(after) ||
		/\.unlink\s*\(/.test(after) ||
		/\.replace\s*\(\s*(?:old|new|path)/.test(after)
	) {
		return "mutate";
	}
	if (/!edit\b/.test(before) || /--path\b/.test(before)) {
		return "mutate";
	}
	if (/open\s*\(\s*$/.test(before) && /['"][wax+]/.test(after)) {
		return "mutate";
	}
	if (/\.read_(?:text|bytes)\s*\(/.test(after)) {
		return "read";
	}
	if (/(?:print_range|show)\s*\(\s*$/.test(before)) {
		return "read";
	}
	if (/open\s*\(\s*$/.test(before)) {
		return "read";
	}
	return "unclassified";
}

function classifyBashLiteral(command: string, raw: string): FileAccessKind | undefined {
	const escaped = escapeRegExp(raw);
	if (new RegExp(`(?:>>|>)\\s*['"]?${escaped}`).test(command)) {
		return "mutate";
	}
	if (
		(/\bsed\b/.test(command) && /(?:^|\s)-i\b/.test(command)) ||
		(/\bperl\b/.test(command) && /(?:^|\s)-pi\b/.test(command)) ||
		BASH_MUTATE_CMD_RE.test(command)
	) {
		if (new RegExp(escaped).test(command)) {
			return "mutate";
		}
	}
	if (BASH_READ_RE.test(command) && new RegExp(escaped).test(command)) {
		return "read";
	}
	return undefined;
}

function extractPathLiterals(text: string): PathLiteral[] {
	const found: PathLiteral[] = [];
	const seen = new Set<string>();
	const add = (raw: string, index: number, length: number) => {
		if (!isFilePathLiteral(raw)) {
			return;
		}
		const key = `${index}:${raw}`;
		if (seen.has(key)) {
			return;
		}
		seen.add(key);
		found.push({ raw, index, length });
	};

	for (const match of text.matchAll(QUOTED_STRING_RE)) {
		if (match.index === undefined) {
			continue;
		}
		add(match[2], match.index, match[0].length);
	}
	for (const match of text.matchAll(TOKEN_RE)) {
		if (match.index === undefined) {
			continue;
		}
		let token = match[0];
		let index = match.index;
		while (token.startsWith("<") || token.startsWith(">")) {
			token = token.slice(1);
			index += 1;
		}
		token = token.replace(/[,;]+$/, "");
		if (token.startsWith("'") || token.startsWith('"')) {
			continue;
		}
		add(token, index, token.length);
	}
	return found;
}

function toAccess(literal: PathLiteral, kind: FileAccessKind, code: string, cwd: string): ExtractedFileAccess {
	const after = code.slice(literal.index + literal.length);
	const rangeMatch = /^\s*,\s*(\d+)\s*,\s*(\d+)/.exec(after);
	const access: ExtractedFileAccess = { relPath: toPosixRelPath(literal.raw, cwd), kind };
	if (rangeMatch) {
		access.start = Number(rangeMatch[1]);
		access.end = Number(rangeMatch[2]);
	}
	return access;
}

function callSpans(code: string, calleeRe: RegExp): Span[] {
	const spans: Span[] = [];
	const re = new RegExp(calleeRe.source, calleeRe.flags.includes("g") ? calleeRe.flags : `${calleeRe.flags}g`);
	for (const match of code.matchAll(re)) {
		if (match.index === undefined) {
			continue;
		}
		const open = match.index + match[0].length - 1;
		spans.push({ start: match.index, end: findCallEnd(code, open) });
	}
	return spans;
}

function findCallEnd(text: string, openParenIndex: number): number {
	let depth = 0;
	let quote: string | undefined;
	let escaped = false;
	for (let i = openParenIndex; i < text.length; i++) {
		const ch = text[i];
		if (quote) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (ch === "\\") {
				escaped = true;
				continue;
			}
			if (ch === quote) {
				quote = undefined;
			}
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (ch === "(") {
			depth++;
			continue;
		}
		if (ch === ")") {
			depth--;
			if (depth === 0) {
				return i + 1;
			}
		}
	}
	return text.length;
}

function inSpans(index: number, spans: Span[]): boolean {
	return spans.some((span) => index >= span.start && index < span.end);
}

function isExhausted(state: FileCoverage | undefined, identity: string, range: LineRange, maxRepeats: number): boolean {
	if (!state || state.identity !== identity || !isSubset(range, state.covered)) {
		return false;
	}
	return state.noProgressCount + 1 >= maxRepeats;
}

function collectArgText(args: unknown): string {
	if (!args || typeof args !== "object") {
		return "";
	}
	const record = args as Record<string, unknown>;
	const parts: string[] = [];
	if (typeof record.code === "string") {
		parts.push(record.code);
	}
	if (typeof record.command === "string") {
		parts.push(record.command);
	}
	return parts.join("\n");
}

function pathArg(args: unknown): string | undefined {
	if (!args || typeof args !== "object") {
		return undefined;
	}
	const path = (args as Record<string, unknown>).path;
	return typeof path === "string" ? path : undefined;
}

function isFilePathLiteral(value: string): boolean {
	if (value.includes("://") || value.includes("::") || /\s/.test(value)) {
		return false;
	}
	if (!SOURCE_FILE_EXT.test(value)) {
		return false;
	}
	return value.includes("/") || value.includes("\\") || /^[\w.-]+\.[A-Za-z0-9]+$/.test(value);
}

function toPosixRelPath(raw: string, cwd: string): string {
	const resolved = resolveToCwd(raw.replace(/\\/g, "/"), cwd);
	const rel = relative(cwd, resolved);
	if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
		return rel.replace(/\\/g, "/");
	}
	return resolved.replace(/\\/g, "/");
}

function toRange(access: ExtractedFileAccess): LineRange {
	if (
		typeof access.start === "number" &&
		typeof access.end === "number" &&
		Number.isFinite(access.start) &&
		Number.isFinite(access.end) &&
		access.end >= access.start
	) {
		return { start: access.start, end: access.end };
	}
	return FULL_RANGE;
}

function isSubset(range: LineRange, covered: LineRange[]): boolean {
	return covered.some((entry) => range.start >= entry.start && range.end <= entry.end);
}

function fileIdentity(absPath: string): string | undefined {
	try {
		const stat = statSync(absPath);
		if (!stat.isFile()) {
			return undefined;
		}
		return `${stat.size}:${Math.trunc(stat.mtimeMs)}`;
	} catch {
		return undefined;
	}
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
