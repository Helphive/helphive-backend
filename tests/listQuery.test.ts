// Run with: npx ts-node tests/listQuery.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { ListQueryError, escapeRegex, parseDateBound, parseListQuery, type ListSpec } from "../lib/listQuery";
import { AUDIT_LIST_SPEC } from "../controllers/admin/audit.controller";
import { ADMIN_LIST_SPEC } from "../controllers/admin/admins.controller";

const SPEC: ListSpec = {
	sortable: { createdAt: "createdAt", amount: "amount" },
	defaultSort: "-createdAt",
	filters: {
		status: { type: "enum", path: "status", values: ["pending", "paid"] },
		userId: { type: "objectId", path: "userId" },
		read: { type: "boolean", path: "read" },
		amount: { type: "number", path: "amount", min: 0, max: 10000 },
	},
	dateField: "createdAt",
	searchFields: ["email", "name"],
	maxPageSize: 50,
};

const fails = (query: Record<string, unknown>, field: string, spec: ListSpec = SPEC) =>
	assert.throws(
		() => parseListQuery(query, spec),
		(error: unknown) => error instanceof ListQueryError && error.field === field,
		JSON.stringify(query),
	);

test("defaults: page 1, default page size, default sort with an _id tie-breaker, empty filter", () => {
	assert.deepEqual(parseListQuery({}, SPEC), {
		filter: {},
		sort: { createdAt: -1, _id: -1 },
		page: 1,
		pageSize: 25,
		skip: 0,
	});
});

test("paging: page size capped at the endpoint maximum (and never above 100); skip computed", () => {
	const parsed = parseListQuery({ page: "3", pageSize: "500" }, SPEC);
	assert.equal(parsed.pageSize, 50);
	assert.equal(parsed.skip, 100);
	assert.equal(parseListQuery({ limit: "10" }, SPEC).pageSize, 10, "limit is an alias");
	assert.equal(parseListQuery({ pageSize: "1000" }, { ...SPEC, maxPageSize: 5000 }).pageSize, 100);
	fails({ page: "0" }, "page");
	fails({ page: "-1" }, "page");
	fails({ page: "1.5" }, "page");
	fails({ page: "1e9" }, "page");
	fails({ pageSize: "0" }, "pageSize");
});

test("sorting only on whitelisted fields", () => {
	assert.deepEqual(parseListQuery({ sort: "amount" }, SPEC).sort, { amount: 1, _id: 1 });
	fails({ sort: "password" }, "sort");
	fails({ sort: "-$where" }, "sort");
	fails({ sort: "__proto__" }, "sort");
	fails({ sort: "constructor" }, "sort");
});

test("filters: typed, whitelisted, single values only", () => {
	const id = "64b7f0c2a1b2c3d4e5f60718";
	const parsed = parseListQuery({ status: "paid", userId: id, read: "false", amount: "12.5" }, SPEC);
	assert.deepEqual(parsed.filter, {
		$and: [{ status: "paid" }, { userId: new mongoose.Types.ObjectId(id) }, { read: false }, { amount: 12.5 }],
	});
	fails({ status: "refunded" }, "status");
	fails({ userId: "not-an-id" }, "userId");
	fails({ read: "yes" }, "read");
	fails({ amount: "-1" }, "amount");
	fails({ amount: "1e3" }, "amount");
	fails({ password: "x" }, "password");
	fails({ $where: "1" }, "$where");
	assert.deepEqual(parseListQuery({ status: "" }, SPEC).filter, {}, "an empty filter is ignored");
});

test("hostile input: arrays and objects (operator injection) are refused, not passed to MongoDB", () => {
	fails({ status: ["paid", "pending"] }, "status");
	fails({ status: { $ne: "paid" } }, "status");
	fails({ q: { $regex: ".*" } }, "q");
	fails({ sort: ["createdAt"] }, "sort");
	fails({ page: { $gt: 1 } }, "page");
	fails({ from: ["2026-01-01"] }, "from");
});

test("search: escaped literal, case-insensitive, length-capped; regex metacharacters lose their meaning", () => {
	const parsed = parseListQuery({ q: "  jane.doe+1@(x)  " }, SPEC);
	assert.deepEqual(parsed.filter, {
		$or: [
			{ email: { $regex: "jane\\.doe\\+1@\\(x\\)", $options: "i" } },
			{ name: { $regex: "jane\\.doe\\+1@\\(x\\)", $options: "i" } },
		],
	});
	// A catastrophic-backtracking pattern becomes a plain literal: no quantifiers survive escaping.
	const evil = "(a+)+$";
	const pattern = escapeRegex(evil);
	assert.equal(new RegExp(pattern).test(evil), true);
	assert.equal(new RegExp(pattern).test("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!"), false);
	const started = Date.now();
	new RegExp(escapeRegex("(a|a)*(a|a)*(a|a)*b"), "i").test("a".repeat(5000));
	assert.ok(Date.now() - started < 50);
	fails({ q: "x".repeat(101) }, "q");
	fails({ q: "x" }, "q", { ...SPEC, searchFields: undefined });
	assert.deepEqual(parseListQuery({ q: "   " }, SPEC).filter, {}, "blank search ignored");
});

test("date range: dates or zoned ISO times; a date-only end includes that whole day; order checked", () => {
	const parsed = parseListQuery({ from: "2026-01-01", to: "2026-01-31" }, SPEC);
	assert.deepEqual(parsed.filter, {
		createdAt: { $gte: new Date("2026-01-01T00:00:00.000Z"), $lt: new Date("2026-02-01T00:00:00.000Z") },
	});
	assert.deepEqual(parseDateBound("2026-01-01T10:00:00+02:00", "from", false), new Date("2026-01-01T08:00:00Z"));
	fails({ from: "yesterday" }, "from");
	fails({ from: "2026-01-01T10:00:00" }, "from", SPEC); // no zone
	fails({ from: "2026-13-45" }, "from");
	fails({ from: "2026-02-01", to: "2026-01-01" }, "from");
	fails({ from: "2026-01-01" }, "from", { ...SPEC, dateField: undefined });
});

test("audit list: actor by id or exact email, action exact or by prefix, all escaped", () => {
	const id = "64b7f0c2a1b2c3d4e5f60718";
	assert.deepEqual(parseListQuery({ actor: id }, AUDIT_LIST_SPEC).filter, {
		"actor.id": new mongoose.Types.ObjectId(id),
	});
	assert.deepEqual(parseListQuery({ actor: "Ops@Example.com" }, AUDIT_LIST_SPEC).filter, {
		"actor.email": { $regex: "^Ops@Example\\.com$", $options: "i" },
	});
	assert.deepEqual(parseListQuery({ action: "admins." }, AUDIT_LIST_SPEC).filter, {
		action: { $regex: "^admins\\." },
	});
	assert.deepEqual(parseListQuery({ action: "auth.login.failed" }, AUDIT_LIST_SPEC).filter, {
		action: "auth.login.failed",
	});
	fails({ action: ".*" }, "action", AUDIT_LIST_SPEC);
	fails({ actor: "nobody" }, "actor", AUDIT_LIST_SPEC);
	fails({ sort: "-ip" }, "sort", AUDIT_LIST_SPEC);
});

test("admin list: role filter understands legacy admins", () => {
	assert.deepEqual(parseListQuery({ role: "superAdmin" }, ADMIN_LIST_SPEC).filter, {
		$or: [{ role: "superAdmin" }, { role: { $exists: false }, "roles.superAdmin": true }],
	});
	assert.deepEqual(parseListQuery({ status: "disabled" }, ADMIN_LIST_SPEC).filter, { disabled: true });
	fails({ role: "owner" }, "role", ADMIN_LIST_SPEC);
});
