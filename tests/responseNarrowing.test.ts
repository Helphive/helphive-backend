// Run with: npx ts-node tests/responseNarrowing.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import {
	COUNTERPARTY_SELECT,
	toCounterparty,
	withCounterparties,
} from "../controllers/user-controllers/utils/counterparty.utils";
import { hasRefund, serializePayment } from "../controllers/user-controllers/utils/payment.utils";
import { findUnsafeKey } from "../middleware/sanitizeInput";
import { classifyUpload } from "../middleware/uploads";

const fullProvider = {
	_id: new mongoose.Types.ObjectId(),
	firstName: "Pat",
	lastName: "Lee",
	email: "pat@example.com",
	phone: "+44 7000 000000",
	profile: "abc/profile.jpg",
	street: "1 high street",
	city: "london",
	currentLocation: { latitude: 51.5, longitude: -0.12 },
	isProviderAvailable: true,
	availableBalance: 420,
	stripeConnectedAccountId: "acct_123",
	roles: { User: false, Provider: true },
	providerApplications: [new mongoose.Types.ObjectId()],
	selectedJobTypes: [{ id: 1 }],
};

test("a counterparty keeps only what the apps display", () => {
	const narrowed = toCounterparty(fullProvider) as Record<string, unknown>;
	assert.deepEqual(Object.keys(narrowed).sort(), ["_id", "email", "firstName", "lastName", "phone", "profile"]);
	for (const hidden of ["currentLocation", "street", "availableBalance", "stripeConnectedAccountId", "roles"]) {
		assert.equal(hidden in narrowed, false, `${hidden} must not reach the other party`);
	}
	assert.equal(COUNTERPARTY_SELECT.includes("currentLocation"), false);
});

test("a mongoose document is converted before narrowing", () => {
	const doc = { toObject: () => ({ ...fullProvider, rating: 4.5 }) };
	assert.deepEqual(toCounterparty(doc), {
		_id: fullProvider._id,
		firstName: "Pat",
		lastName: "Lee",
		email: "pat@example.com",
		phone: "+44 7000 000000",
		profile: "abc/profile.jpg",
		rating: 4.5,
	});
});

test("unpopulated references and empty values pass through unchanged", () => {
	const id = new mongoose.Types.ObjectId();
	assert.equal(toCounterparty(id), id);
	assert.equal(toCounterparty("64b7f0c2a1b2c3d4e5f60718"), "64b7f0c2a1b2c3d4e5f60718");
	assert.equal(toCounterparty(null), null);
	assert.equal(toCounterparty(undefined), undefined);
});

test("withCounterparties narrows both sides and keeps the booking fields", () => {
	const booking = { _id: "b1", status: "pending", address: "Hotel", userId: fullProvider, providerId: null };
	const result = withCounterparties(booking) as any;
	assert.equal(result.status, "pending");
	assert.equal(result.address, "Hotel");
	assert.equal(result.providerId, null);
	assert.equal(result.userId.currentLocation, undefined);
	assert.equal(result.userId.firstName, "Pat");
});

test("a refund exists only with a refund id; the stale default reads as no refund", () => {
	assert.equal(hasRefund({ refundId: "re_1" }), true);
	assert.equal(hasRefund({ refundStatus: "pending" } as any), false);
	assert.equal(hasRefund(null), false);
	const legacy = serializePayment(
		{ amount: 50, status: "completed", refundStatus: "pending", clientSecret: "pi_secret" },
		{ includeClientSecret: false },
	);
	assert.equal(legacy.refundStatus, null);
	assert.equal(legacy.clientSecret, undefined);
	const refunded = serializePayment(
		{ amount: 50, refundId: "re_1", refundStatus: "succeeded", refundAmount: 50, clientSecret: "pi_secret" },
		{ includeClientSecret: true },
	);
	assert.equal(refunded.refundStatus, "succeeded");
	assert.equal(refunded.refundAmount, 50);
	assert.equal(refunded.clientSecret, "pi_secret");
});

test("operator and dotted keys are found anywhere in a body or query", () => {
	assert.equal(findUnsafeKey({ email: { $ne: null } }), "email.$ne");
	assert.equal(findUnsafeKey({ a: [{ b: { $gt: 1 } }] }), "a.0.b.$gt");
	assert.equal(findUnsafeKey({ "profile.email": "x" }), "profile.email");
	assert.equal(findUnsafeKey(JSON.parse('{"__proto__": {"admin": true}}')), "__proto__");
	assert.equal(findUnsafeKey({ email: "a@b.com", currentLocation: { latitude: 1, longitude: 2 } }), null);
	assert.equal(findUnsafeKey("plain"), null);
});

test("uploads: allow-listed types only, stored extension never taken from untrusted text", () => {
	assert.deepEqual(classifyUpload("image", "me.PNG", "image/png"), { extension: "png", contentType: "image/png" });
	// Some phones send no file name; the declared type decides.
	assert.deepEqual(classifyUpload("image", "undefined", "image/jpeg"), {
		extension: "jpg",
		contentType: "image/jpeg",
	});
	assert.equal(classifyUpload("image", "cv.pdf", "application/pdf"), null);
	assert.deepEqual(classifyUpload("document", "cv.pdf", "application/pdf"), {
		extension: "pdf",
		contentType: "application/pdf",
	});
	assert.equal(classifyUpload("document", "page.html", "text/html"), null);
	assert.equal(classifyUpload("image", "x.svg", "image/svg+xml"), null, "SVG can carry script");
	assert.equal(classifyUpload("document", "a.pdf/../../evil", "application/octet-stream"), null);
});
