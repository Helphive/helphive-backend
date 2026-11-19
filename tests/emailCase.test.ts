import assert from "node:assert/strict";
import test from "node:test";
import { validationResult } from "express-validator";
import { validateLoginFields, validateSignupFields } from "../controllers/user-controllers/validators/auth.validators";

const run = async (chains: any[], body: Record<string, unknown>) => {
	const req: any = { body: { ...body } };
	for (const chain of chains) await chain.run(req);
	return { req, errors: validationResult(req).array() };
};

test("sign-in and sign-up accept an address in any letter case and pass it on lower-cased", async () => {
	const login = await run(validateLoginFields, { email: "  JOHN.Smith@Gmail.COM ", password: "x" });
	assert.deepEqual(login.errors, []);
	assert.equal(login.req.body.email, "john.smith@gmail.com");

	const signup = await run(validateSignupFields, {
		firstName: "John",
		lastName: "Smith",
		email: "USER@Example-Hotel.com",
		password: "Str0ng-enough-pass!",
		confirmPassword: "Str0ng-enough-pass!",
	});
	assert.deepEqual(
		signup.errors.filter((e: any) => e.path === "email"),
		[],
	);
	assert.equal(signup.req.body.email, "user@example-hotel.com");
});

test("a value that is not text is still refused", async () => {
	const login = await run(validateLoginFields, { email: { $ne: "" }, password: "x" });
	assert.ok(login.errors.some((e: any) => e.path === "email"));
});
