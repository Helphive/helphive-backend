// Scrubbing for error text that leaves the request: client error reports and server error messages kept for the
// error tracker. Removes credentials, email addresses, network addresses, street addresses, long numbers and query
// strings, so a stored report can be shown to any admin. Pure.

const RULES: [RegExp, string][] = [
	// Credentials first, before shorter patterns eat parts of them.
	[/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]"],
	[/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, "[token]"],
	[/\b(pi|seti|cs)_[A-Za-z0-9]+_secret_[A-Za-z0-9]+/g, "[secret]"],
	[/\b(sk|rk|pk|whsec)_(live|test)?_?[A-Za-z0-9]{8,}/g, "[key]"],
	[
		/\b(access_?token|refresh_?token|id_?token|token|secret|password|passwd|pwd|api_?key|apikey|authorization|auth|code|signature|sig|session|cookie|otp)(["']?\s*[:=]\s*["']?)[^\s"'&,;}]+/gi,
		"$1$2[redacted]",
	],
	// URLs: keep scheme, host and path; drop the query string and fragment (reset and verify links carry tokens).
	[/(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>)]*/gi, "$1"],
	[/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]"],
	[/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[ip]"],
	[/\b(?:[0-9a-f]{1,4}:){4,7}[0-9a-f]{1,4}\b/gi, "[ip]"],
	[
		/\b\d{1,5}\s+(?:[A-Za-z0-9.'-]+\s+){0,4}(?:street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|court|ct|way|place|pl|terrace|close|crescent|square|sq|highway|hwy)\b\.?/gi,
		"[address]",
	],
	// Card, phone and other long numbers (ids are hex and survive).
	[/\+?\d[\d -]{8,}\d/g, "[number]"],
];

export const scrubText = (value: unknown, maxLength = 2000): string => {
	let text = typeof value === "string" ? value : value == null ? "" : String(value);
	if (text.length > maxLength * 2) text = text.slice(0, maxLength * 2);
	for (const [pattern, replacement] of RULES) text = text.replace(pattern, replacement);
	return text.slice(0, maxLength);
};

/** A route or screen name without query string or ids: "/bookings/65f0.../pay?x=1" -> "/bookings/:id/pay". */
export const scrubRoute = (value: unknown, maxLength = 200): string | null => {
	if (typeof value !== "string" || !value.trim()) return null;
	let route = value.trim();
	try {
		if (/^https?:\/\//i.test(route)) route = new URL(route).pathname;
	} catch {
		// Not a URL; use as given.
	}
	route = route.replace(/[?#].*$/, "");
	route = route
		.split("/")
		.map((part) =>
			/^[a-f\d]{24}$/i.test(part) ||
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(part) ||
			/^\d+$/.test(part) ||
			/@/.test(part)
				? ":id"
				: part,
		)
		.join("/");
	route = scrubText(route, maxLength);
	return route || null;
};
