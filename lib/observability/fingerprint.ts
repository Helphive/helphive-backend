// Error fingerprints: errors that are "the same problem" get the same 16-hex-character id, so they group together
// whatever ids, numbers or addresses appear in the message and whichever build produced the stack. Pure.
import crypto from "crypto";

/** The message with variable parts replaced by placeholders. */
export const normalizeMessage = (message: unknown): string =>
	String(message ?? "")
		.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
		.replace(/\b[a-f\d]{24}\b/gi, "<id>")
		.replace(/\b(?:pi|re|tr|po|ch|cus|pm|acct|evt|in|seti|txn|py)_[A-Za-z0-9]+/g, "<stripe-id>")
		.replace(/https?:\/\/\S+/gi, "<url>")
		.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "<email>")
		.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "<ip>")
		.replace(/"[^"]{0,200}"|'[^']{0,200}'|`[^`]{0,200}`/g, "<str>")
		.replace(/\b0x[0-9a-f]+\b/gi, "<hex>")
		.replace(/\b[0-9a-f]{12,}\b/gi, "<hex>")
		.replace(/\d+(\.\d+)?/g, "<n>")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 300);

export interface StackFrame {
	fn: string;
	file: string;
}

const V8_FRAME = /^\s*at\s+(?:(.+?)\s+\()?(.+?)(?::\d+)?(?::\d+)?\)?\s*$/;
const GECKO_FRAME = /^\s*(.*?)@(.+?)(?::\d+)?(?::\d+)?\s*$/;

/** Path without host, query, line and column, and without content hashes in bundled asset names. */
const normalizeFile = (file: string) => {
	let path = file.trim();
	path = path.replace(/^(?:webpack|file|https?):\/\/[^/]*/i, "");
	path = path.replace(/[?#].*$/, "");
	path = path.replace(/:\d+(?::\d+)?$/, "");
	// Server builds: keep the path from the app root (dist/ or the project folder).
	const root = [/\/node_modules\//, /\/(?:dist|src)\//].map((re) => path.search(re)).find((i) => i > 0);
	if (root !== undefined) path = path.slice(root);
	// Vite bundles: index-3fA9c2bD.js -> index.js (a hash has a digit; "payments.controller.js" is kept)
	path = path.replace(/-(?=[A-Za-z0-9_]*\d)[A-Za-z0-9_]{6,}(\.m?js)$/, "$1");
	return path.slice(0, 200);
};

/** Function names from minified code ("a", "Xe") change with every build; they do not identify anything. */
const meaningfulFn = (fn: string) => (fn.replace(/^(?:async |new |Object\.|Module\.)/, "").length > 2 ? fn : "");

export const parseStack = (stack: unknown): StackFrame[] => {
	if (typeof stack !== "string") return [];
	const frames: StackFrame[] = [];
	for (const line of stack.split("\n").slice(0, 60)) {
		const v8 = line.includes(" at ") || /^\s*at\s/.test(line) ? V8_FRAME.exec(line) : null;
		const match = v8 ?? (line.includes("@") ? GECKO_FRAME.exec(line) : null);
		if (!match) continue;
		const fn = meaningfulFn((match[1] ?? "").trim().slice(0, 120));
		const file = normalizeFile(match[2] ?? "");
		if (!file && !fn) continue;
		frames.push({ fn, file });
	}
	return frames;
};

const isAppFrame = (frame: StackFrame) =>
	!!frame.file &&
	!frame.file.includes("node_modules") &&
	!frame.file.startsWith("node:") &&
	!frame.file.startsWith("internal/") &&
	frame.file !== "<anonymous>" &&
	frame.file !== "native";

/** The top `count` frames that are the app's own code (falling back to any frames when none are). */
export const topFrames = (stack: unknown, count = 3): StackFrame[] => {
	const frames = parseStack(stack);
	const app = frames.filter(isAppFrame);
	return (app.length ? app : frames).slice(0, count);
};

/** "fn (file)" of the top app frame: where the error was raised. */
export const culpritOf = (stack: unknown): string | null => {
	const [frame] = topFrames(stack, 1);
	if (!frame) return null;
	return frame.fn ? `${frame.fn} (${frame.file})` : frame.file;
};

export interface FingerprintInput {
	source: "server" | "client";
	/** Error class name ("TypeError"), or "HTTP 500" when only the status is known. */
	type?: string | null;
	message?: string | null;
	stack?: string | null;
	/** Used only when there is no stack, so stackless errors on different routes do not merge. */
	route?: string | null;
	/** Client errors: web, ios, android, admin (each is its own codebase). */
	platform?: string | null;
}

export const fingerprintOf = (input: FingerprintInput): string => {
	const frames = topFrames(input.stack, 3);
	const parts = [
		input.source,
		input.source === "client" ? (input.platform ?? "") : "",
		(input.type ?? "Error").slice(0, 60),
		normalizeMessage(input.message),
		frames.length ? frames.map((f) => `${f.fn}@${f.file}`).join(">") : `route:${input.route ?? ""}`,
	];
	return crypto.createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 16);
};

/** Cloud Run revision names end in a zero-padded sequence number (helphive-00042-xyz); larger is newer. */
export const revisionNumber = (revision: string | null | undefined): number | null => {
	const match = /-(\d{3,})-[a-z0-9]{2,}$/i.exec(revision ?? "");
	return match ? Number(match[1]) : null;
};

/** True when `candidate` is a later revision than `reference` (unknown numbering: any different name counts). */
export const isNewerRevision = (candidate: string | null | undefined, reference: string | null | undefined) => {
	if (!candidate || candidate === reference) return false;
	if (!reference) return true;
	const a = revisionNumber(candidate);
	const b = revisionNumber(reference);
	return a !== null && b !== null ? a > b : true;
};
