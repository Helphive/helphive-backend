import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

// The Resend audience must only hold addresses their owner confirmed: sign-up never adds a contact, verification does.
const read = (file: string) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

test("sign-up does not add an audience contact; verifying the email does", () => {
	const routes = read("routes/user-routes/auth.route.ts");
	for (const route of ['"/signup"', '"/provider-signup"']) {
		const start = routes.indexOf(route);
		assert.ok(start > 0, `${route} is mounted`);
		const chain = routes.slice(start, routes.indexOf(");", start));
		assert.match(chain, /sendMagicLinkEmail/);
		assert.doesNotMatch(chain, /contact/i);
	}
	assert.doesNotMatch(read("controllers/email.controller.ts"), /addAudienceContact/);

	const auth = read("controllers/user-controllers/auth.controller.ts");
	const verified = auth.indexOf("user.isEmailVerified = true;");
	const added = auth.indexOf("await addVerifiedContact(user);");
	assert.ok(verified > 0 && added > verified, "the contact is added after the email is marked verified");
	const callers = ["controllers", "routes", "middleware", "lib"].flatMap((dir) =>
		(fs.readdirSync(path.join(__dirname, "..", dir), { recursive: true }) as string[])
			.filter((f) => /\.tsx?$/.test(f))
			.filter((f) => /addAudienceContact\(|addVerifiedContact\(/.test(read(path.join(dir, f))))
			.map((f) => path.join(dir, f).split(path.sep).join("/")),
	);
	assert.deepEqual(callers.sort(), ["controllers/user-controllers/auth.controller.ts", "lib/email.ts"]);
});
