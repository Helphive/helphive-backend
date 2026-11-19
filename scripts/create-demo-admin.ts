// Creates or updates the public demo admin (role "demo": read-only, masked responses; see lib/demoMask.ts).
//
//   DEMO_ADMIN_PASSWORD=... npx ts-node scripts/create-demo-admin.ts            dry run: says what it would do
//   DEMO_ADMIN_PASSWORD=... npx ts-node scripts/create-demo-admin.ts --apply    writes
//   npx ts-node scripts/create-demo-admin.ts --password-file=path --apply        password from a file instead
//   ... --email=demo.admin@helphive.himaiz.com                                   default: first DEMO_ADMIN_EMAILS entry
//
// The password is never printed. It must meet the user password policy, and the email must be listed in
// DEMO_ADMIN_EMAILS on the server (that, not the stored role, is what makes the account read-only and masked).
// Updating an existing account resets its password, role, flags and two-step sign-in, and ends its sessions.
// Reads DATABASE_URI from .env.
import fs from "fs";
import bcrypt from "bcrypt";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

import AdminModel from "../dal/models/admin.model";
import AdminSessionModel from "../dal/models/adminSession.model";
import { DEMO_ADMIN_EMAILS, isDemoAdminEmail } from "../config/demoAccounts";
import { legacyFlagsFor } from "../config/adminPermissions";

const BCRYPT_ROUNDS = 12;

export const passwordProblems = (password: string) =>
	[
		password.length < 8 || password.length > 255 ? "8 to 255 characters" : null,
		/[a-z]/.test(password) ? null : "a lowercase letter",
		/[A-Z]/.test(password) ? null : "an uppercase letter",
		/[0-9]/.test(password) ? null : "a number",
		/[^A-Za-z0-9]/.test(password) ? null : "a special character",
	].filter(Boolean) as string[];

const argValue = (name: string) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);

const main = async () => {
	const apply = process.argv.includes("--apply");
	const unknown = process.argv.slice(2).filter((arg) => arg !== "--apply" && !/^--(email|password-file)=/.test(arg));
	if (unknown.length) {
		// Never echo the arguments: someone may have typed a password there.
		throw new Error("Unknown arguments. Pass the password in DEMO_ADMIN_PASSWORD or with --password-file=path.");
	}
	const email = (argValue("email") ?? [...DEMO_ADMIN_EMAILS][0] ?? "").trim().toLowerCase();
	if (!isDemoAdminEmail(email)) {
		throw new Error(
			"That email is not in DEMO_ADMIN_EMAILS, so the account would not be treated as the demo admin.",
		);
	}
	const passwordFile = argValue("password-file");
	const password = (
		passwordFile ? fs.readFileSync(passwordFile, "utf8") : (process.env.DEMO_ADMIN_PASSWORD ?? "")
	).trim();
	if (!password) throw new Error("Set DEMO_ADMIN_PASSWORD or pass --password-file=path.");
	const problems = passwordProblems(password);
	if (problems.length) throw new Error(`The password needs ${problems.join(", ")}.`);

	if (!process.env.DATABASE_URI) throw new Error("DATABASE_URI is not set.");
	mongoose.set("autoIndex", false);
	await mongoose.connect(process.env.DATABASE_URI);

	const existing = await AdminModel.findOne({ email }).select("_id role").lean().exec();
	console.log(
		`Demo admin ${email}: ${existing ? "exists; would reset password, role and flags" : "would be created"}.`,
	);
	if (!apply) {
		console.log("Dry run: nothing written. Run again with --apply.");
		await mongoose.disconnect();
		return;
	}

	const fields = {
		firstName: "Demo",
		lastName: "Admin",
		email,
		password: await bcrypt.hash(password, BCRYPT_ROUNDS),
		role: "demo" as const,
		roles: legacyFlagsFor("demo"),
		disabled: false,
		disabledAt: null,
		mustChangePassword: false,
		temporaryPasswordExpiresAt: null,
		passwordChangedAt: new Date(),
		mfa: { enabled: false, secret: null, pendingSecret: null, recoveryCodes: [] },
		updatedAt: new Date(),
	};
	if (existing) {
		await AdminModel.updateOne({ _id: existing._id }, { $set: fields, $inc: { tokenVersion: 1 } }).exec();
		await AdminSessionModel.updateMany(
			{ adminId: existing._id, revokedAt: null },
			{ $set: { revokedAt: new Date(), revokedReason: "password_changed" } },
		).exec();
		console.log("Updated. Existing demo sessions were ended.");
	} else {
		await AdminModel.create({ ...fields, createdAt: new Date() });
		console.log("Created.");
	}
	await mongoose.disconnect();
};

if (require.main === module) {
	main().catch(async (error) => {
		console.error(error instanceof Error ? error.message : "Failed.");
		await mongoose.disconnect().catch(() => undefined);
		process.exit(1);
	});
}
