// Shared parsing for admin list endpoints: paging, a whitelist of sortable and filterable fields, a date range and
// a plain-text search. Every list answers { items, page, pageSize, total }.
//
// Query parameters (all optional):
//   page=1  pageSize=25 (max per endpoint, never above 100)  sort=-createdAt (one whitelisted field, "-" = descending)
//   from=2026-01-01  to=2026-01-31 (dates or ISO times; a date-only "to" includes that whole day, UTC)
//   q=text (case-insensitive substring over the endpoint's search fields; at most 100 characters)
//   <filter>=value for each whitelisted filter (exact match; enum, ObjectId, boolean, string or number)
//
// Safety: values must be single strings (arrays and objects are refused, so no "?status[$ne]=x"), field names come
// only from the whitelist, search text is escaped into a literal pattern (no regex operators, so no catastrophic
// backtracking), and every query runs with a time limit.
import mongoose from "mongoose";

export type FilterSpec =
	| { type: "enum"; path: string; values: readonly string[] }
	| { type: "objectId"; path: string }
	| { type: "boolean"; path: string }
	| { type: "string"; path: string; maxLength?: number }
	| { type: "number"; path: string; min?: number; max?: number }
	| { type: "custom"; parse: (value: string) => Record<string, unknown> | null };

export interface ListSpec {
	/** Public sort key -> document path. */
	sortable: Record<string, string>;
	defaultSort: string;
	filters?: Record<string, FilterSpec>;
	/** Document path the from/to range applies to; omit to disable the range. */
	dateField?: string;
	/** Document paths `q` searches; omit to disable search. */
	searchFields?: readonly string[];
	defaultPageSize?: number;
	maxPageSize?: number;
}

export interface ParsedList {
	filter: Record<string, unknown>;
	sort: Record<string, 1 | -1>;
	page: number;
	pageSize: number;
	skip: number;
}

export class ListQueryError extends Error {
	constructor(
		message: string,
		readonly field: string,
	) {
		super(message);
	}
}

export const HARD_MAX_PAGE_SIZE = 100;
export const MAX_PAGE = 10_000;
export const MAX_SEARCH_LENGTH = 100;
export const LIST_QUERY_TIME_LIMIT_MS = 5000;

const RESERVED = new Set(["page", "pageSize", "limit", "sort", "from", "to", "q"]);

/** Escapes every regular-expression metacharacter so the text matches literally. */
export const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");

const single = (query: Record<string, unknown>, name: string): string | undefined => {
	const value = query[name];
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new ListQueryError(`${name} must be given once, as text.`, name);
	return value;
};

const integer = (value: string | undefined, name: string, fallback: number, min: number, max: number) => {
	if (value === undefined || value === "") return fallback;
	if (!/^\d{1,6}$/.test(value)) throw new ListQueryError(`${name} must be a whole number.`, name);
	const parsed = Number(value);
	if (parsed < min) throw new ListQueryError(`${name} must be at least ${min}.`, name);
	return Math.min(parsed, max);
};

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

/** A date bound: "YYYY-MM-DD" (UTC) or a full ISO time with zone. An end date-only bound means the end of that day. */
export const parseDateBound = (value: string, name: string, endOfDay: boolean): Date => {
	if (!DATE_ONLY.test(value) && !ISO_TIME.test(value)) {
		throw new ListQueryError(`${name} must be a date (YYYY-MM-DD) or an ISO time with a zone.`, name);
	}
	const date = new Date(DATE_ONLY.test(value) ? `${value}T00:00:00.000Z` : value);
	if (Number.isNaN(date.getTime())) throw new ListQueryError(`${name} is not a valid date.`, name);
	if (endOfDay && DATE_ONLY.test(value)) date.setUTCDate(date.getUTCDate() + 1);
	return date;
};

const filterValue = (name: string, spec: FilterSpec, raw: string): Record<string, unknown> => {
	switch (spec.type) {
		case "enum":
			if (!spec.values.includes(raw))
				throw new ListQueryError(`${name} must be one of: ${spec.values.join(", ")}.`, name);
			return { [spec.path]: raw };
		case "objectId":
			if (!/^[a-f\d]{24}$/i.test(raw)) throw new ListQueryError(`${name} must be an id.`, name);
			return { [spec.path]: new mongoose.Types.ObjectId(raw) };
		case "boolean":
			if (raw !== "true" && raw !== "false") throw new ListQueryError(`${name} must be true or false.`, name);
			return { [spec.path]: raw === "true" };
		case "string":
			if (!raw || raw.length > (spec.maxLength ?? 200))
				throw new ListQueryError(`${name} is too long or empty.`, name);
			return { [spec.path]: raw };
		case "number": {
			if (!/^-?\d{1,12}(\.\d{1,6})?$/.test(raw)) throw new ListQueryError(`${name} must be a number.`, name);
			const parsed = Number(raw);
			if ((spec.min !== undefined && parsed < spec.min) || (spec.max !== undefined && parsed > spec.max)) {
				throw new ListQueryError(`${name} is out of range.`, name);
			}
			return { [spec.path]: parsed };
		}
		case "custom": {
			const parsed = spec.parse(raw);
			if (!parsed) throw new ListQueryError(`${name} is not valid.`, name);
			return parsed;
		}
	}
};

/** Parses req.query against an endpoint's spec. Throws ListQueryError (answer 400) on anything not allowed. */
export const parseListQuery = (query: Record<string, unknown>, spec: ListSpec): ParsedList => {
	const maxPageSize = Math.min(spec.maxPageSize ?? HARD_MAX_PAGE_SIZE, HARD_MAX_PAGE_SIZE);
	const page = integer(single(query, "page"), "page", 1, 1, MAX_PAGE);
	const pageSize = integer(
		single(query, "pageSize") ?? single(query, "limit"),
		"pageSize",
		Math.min(spec.defaultPageSize ?? 25, maxPageSize),
		1,
		maxPageSize,
	);

	const sortText = single(query, "sort") || spec.defaultSort;
	const descending = sortText.startsWith("-");
	const sortKey = descending ? sortText.slice(1) : sortText;
	const sortPath = Object.prototype.hasOwnProperty.call(spec.sortable, sortKey) ? spec.sortable[sortKey] : undefined;
	if (!sortPath) {
		throw new ListQueryError(
			`sort must be one of: ${Object.keys(spec.sortable).join(", ")} (prefix - for descending).`,
			"sort",
		);
	}
	// _id breaks ties so pages never overlap or skip records with equal sort values.
	const sort: Record<string, 1 | -1> = { [sortPath]: descending ? -1 : 1 };
	if (sortPath !== "_id") sort._id = descending ? -1 : 1;

	const clauses: Record<string, unknown>[] = [];
	for (const name of Object.keys(query)) {
		if (RESERVED.has(name)) continue;
		const filterSpec =
			spec.filters && Object.prototype.hasOwnProperty.call(spec.filters, name) ? spec.filters[name] : undefined;
		if (!filterSpec) throw new ListQueryError(`Unknown parameter ${name}.`, name);
		const raw = single(query, name) as string;
		if (raw === "") continue;
		clauses.push(filterValue(name, filterSpec, raw));
	}

	const from = single(query, "from");
	const to = single(query, "to");
	if ((from || to) && !spec.dateField) throw new ListQueryError("This list has no date range.", from ? "from" : "to");
	if (spec.dateField && (from || to)) {
		const range: Record<string, Date> = {};
		if (from) range.$gte = parseDateBound(from, "from", false);
		if (to) range.$lt = parseDateBound(to, "to", true);
		if (range.$gte && range.$lt && range.$gte >= range.$lt)
			throw new ListQueryError("from must be before to.", "from");
		clauses.push({ [spec.dateField]: range });
	}

	const q = single(query, "q")?.trim();
	if (q) {
		if (!spec.searchFields?.length) throw new ListQueryError("This list has no search.", "q");
		if (q.length > MAX_SEARCH_LENGTH)
			throw new ListQueryError(`q must be at most ${MAX_SEARCH_LENGTH} characters.`, "q");
		const pattern = escapeRegex(q);
		clauses.push({ $or: spec.searchFields.map((path) => ({ [path]: { $regex: pattern, $options: "i" } })) });
	}

	const filter = clauses.length === 0 ? {} : clauses.length === 1 ? clauses[0] : { $and: clauses };
	return { filter, sort, page, pageSize, skip: (page - 1) * pageSize };
};

export interface ListResult<T> {
	items: T[];
	page: number;
	pageSize: number;
	total: number;
}

/** Runs a parsed list query on a model: one page plus the total count, both with a time limit. */
export const runListQuery = async <T>(
	model: mongoose.Model<any>,
	parsed: ParsedList,
	options: {
		baseFilter?: Record<string, unknown>;
		projection?: string | Record<string, 0 | 1>;
		map?: (doc: any) => T;
	} = {},
): Promise<ListResult<T>> => {
	const filter = options.baseFilter ? { $and: [options.baseFilter, parsed.filter] } : parsed.filter;
	const [docs, total] = await Promise.all([
		model
			.find(filter, options.projection)
			.sort(parsed.sort)
			.skip(parsed.skip)
			.limit(parsed.pageSize)
			.maxTimeMS(LIST_QUERY_TIME_LIMIT_MS)
			.lean()
			.exec(),
		model.countDocuments(filter).maxTimeMS(LIST_QUERY_TIME_LIMIT_MS).exec(),
	]);
	return {
		items: options.map ? docs.map(options.map) : (docs as T[]),
		page: parsed.page,
		pageSize: parsed.pageSize,
		total,
	};
};
