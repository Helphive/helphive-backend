// What one party of a booking may see about the other. The web and mobile apps show the name, photo, email, phone
// and rating of the customer or provider and check that the field is a populated object; nothing else is read.
// In particular the provider's live location, street address, balances, Stripe account and roles stay private.
export const COUNTERPARTY_FIELDS = ["_id", "firstName", "lastName", "email", "phone", "profile", "rating"] as const;

/** Projection for populate() so other fields are never loaded into a booking response. */
export const COUNTERPARTY_SELECT = COUNTERPARTY_FIELDS.join(" ");

export type Counterparty = Partial<Record<(typeof COUNTERPARTY_FIELDS)[number], unknown>>;

/**
 * Copy of a populated user reduced to the counterparty fields. An unpopulated reference (an ObjectId or id string)
 * and null pass through unchanged, since clients treat a non-object as "not loaded".
 */
export const toCounterparty = (person: unknown): unknown => {
	if (!person || typeof person !== "object") return person;
	const source = typeof (person as any).toObject === "function" ? (person as any).toObject() : person;
	// An ObjectId has no firstName/email; leave it as the bare reference it is.
	if (!("firstName" in source) && !("email" in source)) return person;
	const result: Counterparty = {};
	for (const field of COUNTERPARTY_FIELDS) {
		if (source[field] !== undefined) result[field] = source[field];
	}
	return result;
};

/** A booking (document or plain object) with userId and providerId reduced to counterparty fields. */
export const withCounterparties = <T extends Record<string, any>>(booking: T): T => ({
	...booking,
	userId: toCounterparty(booking.userId),
	providerId: toCounterparty(booking.providerId),
});
