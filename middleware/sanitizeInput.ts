import { NextFunction, Request, Response } from "express";

const MAX_DEPTH = 10;

/**
 * Path of the first key that could act as a MongoDB operator or a dotted path ("$ne", "a.b"), or that could pollute a
 * prototype, anywhere in a parsed body or query. Clients never send such keys, so a request carrying one is rejected
 * rather than cleaned.
 */
export const findUnsafeKey = (value: unknown, path = "", depth = 0): string | null => {
	if (value === null || typeof value !== "object") return null;
	if (depth > MAX_DEPTH) return path || "(root)";
	for (const key of Object.keys(value)) {
		const here = path ? `${path}.${key}` : key;
		if (
			key.startsWith("$") ||
			key.includes(".") ||
			key === "__proto__" ||
			key === "constructor" ||
			key === "prototype"
		)
			return here;
		const found = findUnsafeKey((value as Record<string, unknown>)[key], here, depth + 1);
		if (found) return found;
	}
	return null;
};

export const rejectOperatorKeys = (req: Request, res: Response, next: NextFunction) => {
	if (findUnsafeKey(req.body) || findUnsafeKey(req.query)) {
		return res.status(400).json({ message: "Invalid request." });
	}
	next();
};

/** Validation errors without the submitted values, which can include passwords. */
export const publicValidationErrors = (errors: { array: () => any[] }) =>
	errors.array().map((error: any) => ({ path: error.path, msg: error.msg, location: error.location }));
