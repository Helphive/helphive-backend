// Run with: npx ts-node tests/audit.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import { AUDIT_ACTIONS, buildAuditEntry } from "../lib/audit";
import { hashEmail, isSecretKey, maskEmail, redact } from "../lib/redact";
import AuditLogModel, { AuditLogImmutableError } from "../dal/models/auditLog.model";

mongoose.set("bufferTimeoutMS", 200);

const context = { requestId: "req-12345678", ip: "203.0.113.7", userAgent: "Console/1.0" };

test("redaction drops credentials, document links and full emails, at any depth", () => {
	const out = redact(
		{
			status: "rejected",
			password: "hunter2",
			nested: {
				refreshToken: "abc",
				clientSecret: "pi_secret",
				apiKey: "k",
				note: "contact jane.doe@example.com",
			},
			url: "https://storage.googleapis.com/bucket/id.png?X-Goog-Signature=abc",
			gs: "gs://bucket/file",
			id: "abc/id.pdf",
			dbs: "abc/dbs.pdf",
			list: [{ token: "t" }, "ok"],
			when: new Date("2026-01-01T00:00:00Z"),
			oid: new mongoose.Types.ObjectId("64b7f0c2a1b2c3d4e5f60718"),
		},
		{ documentKeys: ["id", "dbs"] },
	) as any;
	assert.equal(out.status, "rejected");
	assert.equal(out.password, "[redacted]");
	assert.equal(out.nested.refreshToken, "[redacted]");
	assert.equal(out.nested.clientSecret, "[redacted]");
	assert.equal(out.nested.apiKey, "[redacted]");
	assert.equal(out.nested.note, "contact j***@example.com");
	assert.equal(out.url, "[url]");
	assert.equal(out.gs, "[url]");
	assert.equal(out.id, "[document]");
	assert.equal(out.dbs, "[document]");
	assert.equal(out.list[0].token, "[redacted]");
	assert.equal(out.when, "2026-01-01T00:00:00.000Z");
	assert.equal(out.oid, "64b7f0c2a1b2c3d4e5f60718");
	assert.ok(isSecretKey("Authorization") && isSecretKey("recoveryCodes") && isSecretKey("mfaSecret"));
	assert.equal(isSecretKey("status"), false);
	assert.equal(maskEmail("ops@helphive.himaiz.com"), "o***@helphive.himaiz.com");
	assert.equal(hashEmail(" A@B.com ", "s"), hashEmail("a@b.com", "s"));
});

test("audit entry: who, what, target, redacted before/after, reason, ip, user agent, request id, time", () => {
	const adminId = new mongoose.Types.ObjectId();
	const now = new Date("2026-11-19T10:00:00Z");
	const entry = buildAuditEntry(
		{
			action: "applications.rejected",
			actor: { type: "admin", id: adminId, email: "ops@helphive.example" },
			target: { type: "provider_application", id: "64b7f0c2a1b2c3d4e5f60718" },
			before: { status: "pending", id: "x/id.png" },
			after: { status: "rejected", rejectReason: "Blurry ID" },
			reason: "Blurry ID",
			documentKeys: ["id"],
		},
		context,
		now,
	);
	assert.equal(entry.at, now);
	assert.equal(entry.action, "applications.rejected");
	assert.equal(entry.outcome, "success");
	assert.ok(entry.actor.id?.equals(adminId));
	assert.equal(entry.actor.email, "ops@helphive.example", "a known admin's email is the record of who acted");
	assert.deepEqual(entry.target, { type: "provider_application", id: "64b7f0c2a1b2c3d4e5f60718" });
	assert.deepEqual(entry.summary, {
		before: { status: "pending", id: "[document]" },
		after: { status: "rejected", rejectReason: "Blurry ID" },
	});
	assert.equal(entry.reason, "Blurry ID");
	assert.equal(entry.ip, "203.0.113.7");
	assert.equal(entry.userAgent, "Console/1.0");
	assert.equal(entry.requestId, "req-12345678");
});

test("a failed sign-in with an unknown email stores it masked, and never a password", () => {
	const entry = buildAuditEntry(
		{
			action: "auth.login.failed",
			outcome: "failure",
			actor: { type: "anonymous", email: "someone.else@example.com" },
			metadata: { reason: "unknown_email", password: "typed" },
		},
		context,
	);
	assert.equal(entry.actor.email, "s***@example.com");
	assert.equal(entry.actor.id, null);
	assert.deepEqual(entry.metadata, { reason: "unknown_email", password: "[redacted]" });
	assert.equal(entry.summary, null);
	assert.equal(
		buildAuditEntry({ action: "auth.logout", actor: { type: "admin" }, reason: "x".repeat(5000) }, undefined).reason
			?.length,
		1000,
	);
});

test("action names are stable dotted lower-case names", () => {
	for (const action of Object.keys(AUDIT_ACTIONS)) assert.match(action, /^[a-z_]+(\.[a-z_]+)+$/);
});

test("the model refuses every update and delete path", async () => {
	const attempts: [string, () => Promise<unknown>][] = [
		["updateOne", () => AuditLogModel.updateOne({}, { $set: { action: "x" } }).exec()],
		["updateMany", () => AuditLogModel.updateMany({}, { $set: { action: "x" } }).exec()],
		["findOneAndUpdate", () => AuditLogModel.findOneAndUpdate({}, { $set: { action: "x" } }).exec()],
		["replaceOne", () => AuditLogModel.replaceOne({}, { action: "x" }).exec()],
		["deleteOne", () => AuditLogModel.deleteOne({}).exec()],
		["deleteMany", () => AuditLogModel.deleteMany({}).exec()],
		["findOneAndDelete", () => AuditLogModel.findOneAndDelete({}).exec()],
		["findOneAndReplace", () => AuditLogModel.findOneAndReplace({}, { action: "x" }).exec()],
		["insertMany", () => AuditLogModel.insertMany([{ action: "x" }])],
	];
	for (const [name, attempt] of attempts) {
		await assert.rejects(attempt(), AuditLogImmutableError, name);
	}
	const existing = AuditLogModel.hydrate({
		_id: new mongoose.Types.ObjectId(),
		action: "auth.logout",
		at: new Date(),
	});
	existing.set("reason", "changed");
	await assert.rejects(existing.save(), AuditLogImmutableError, "saving an existing entry");
	await assert.rejects(existing.deleteOne(), AuditLogImmutableError, "document deleteOne");
});

test("no code updates or deletes audit entries (only lib/audit.ts writes, by create)", () => {
	const root = path.resolve(__dirname, "..");
	const offenders: string[] = [];
	const writers: string[] = [];
	const walk = (dir: string) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (["node_modules", "dist", ".git", "tests"].includes(entry.name)) continue;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (/\.(ts|tsx)$/.test(entry.name)) {
				const text = fs.readFileSync(full, "utf8");
				if (/AuditLog(Model)?\s*\.\s*(update|delete|findOneAnd|replace|bulkWrite|collection)/.test(text))
					offenders.push(full);
				if (/AuditLog(Model)?\s*\.\s*create\(/.test(text))
					writers.push(path.relative(root, full).replace(/\\/g, "/"));
			}
		}
	};
	walk(root);
	assert.deepEqual(offenders, []);
	assert.deepEqual(writers, ["lib/audit.ts"]);
});
