// Finding accounts by email whatever the letter case, and the sign-up duplicate guard.
import UserModel from "../../../dal/models/user.model";
import { SEARCH_COLLATION } from "../../../lib/adminSearch";
import { canonicalEmail, normaliseEmail } from "../../../lib/emailAddress";

type UserDoc = InstanceType<typeof UserModel>;

/**
 * The account for a typed or token email. An exact match first (today's lookup, unchanged for everyone it finds);
 * otherwise a case-insensitive match on the email_ci index (same collation), used only when it is unambiguous, so
 * two old accounts that differ only by case never sign in to each other.
 */
export const findUserByEmail = async (email: unknown): Promise<UserDoc | null> => {
	if (typeof email !== "string" || !email) return null;
	const exact = await UserModel.findOne({ email }).exec();
	if (exact) return exact;
	const normalised = normaliseEmail(email);
	if (!normalised) return null;
	const matches = await UserModel.find({ email: normalised }).collation(SEARCH_COLLATION).limit(2).exec();
	return matches.length === 1 ? matches[0] : null;
};

/** Another account on the same mailbox: same canonical address, or the same email in any letter case. */
export const findSignupConflict = async (email: string) => {
	const [byCanonical, byEmail] = await Promise.all([
		UserModel.findOne({ emailCanonical: canonicalEmail(email) })
			.select("roles")
			.lean()
			.exec(),
		UserModel.findOne({ email: normaliseEmail(email) })
			.collation(SEARCH_COLLATION)
			.select("roles")
			.lean()
			.exec(),
	]);
	return byCanonical ?? byEmail;
};

/** The 409 sign-up has always given for a taken email; the generic one when the other account is unknown. */
export const emailTakenBody = (existing: { roles?: { Provider?: boolean } } | null) => ({
	message: existing?.roles?.Provider
		? "A provider account already exists on this email. Please use a different one."
		: "An account already exists on this email. Please use a different one.",
});

/** MongoDB duplicate-key error (E11000), e.g. two sign-ups for the same mailbox at once. */
export const isDuplicateKeyError = (error: unknown) => (error as { code?: unknown })?.code === 11000;
