// Payments created before refundStatus lost its default carry refundStatus "pending" although no refund was ever
// made. A refund exists only when a refund id is present; everything that reads or returns refund state uses this.
export const hasRefund = (payment: { refundId?: string | null } | null | undefined): boolean => !!payment?.refundId;

/** Payment as JSON for its owner, with refund fields cleared when no refund was issued. */
export const serializePayment = (payment: any, { includeClientSecret }: { includeClientSecret: boolean }) => {
	if (!payment) return payment;
	const plain = typeof payment.toObject === "function" ? payment.toObject() : { ...payment };
	if (!includeClientSecret) delete plain.clientSecret;
	// Admin refund bookkeeping stays on the server; the apps read the top-level refund fields as before.
	delete plain.refunds;
	delete plain.refundVersion;
	if (!hasRefund(plain)) {
		plain.refundStatus = null;
		delete plain.refundAmount;
		delete plain.refundCreated;
	}
	return plain;
};
