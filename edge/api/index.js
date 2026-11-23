// Cloudflare Worker on api.helphive.himaiz.com: the zone's WAF runs before it, then it forwards every request
// unchanged to the Cloud Run service, adding the shared secret the API requires and the visitor's address.
// Bodies stream through (Stripe webhooks keep their exact bytes) and WebSocket upgrades pass through.
// Each request is logged as one JSON line (OracleVMOps LOGGING.md) and carries the visitor's CF-Ray to the API as
// X-CF-Ray, which the API logs as `ray`, so one ray finds the request at the edge and at the API.

// The first path segment only ("/auth/*"): the full path can carry ids and tokens.
const routeOf = (pathname) => {
	const first = pathname.split("/")[1];
	return first ? `/${first}/*` : "/";
};

// Cloud Run's probes and CORS preflights are logged at debug, as the API does.
const PROBES = new Set(["/readyz", "/healthz", "/livez"]);

export default {
	async fetch(request, env) {
		const started = Date.now();
		const url = new URL(request.url);
		const ray = request.headers.get("cf-ray") ?? "";
		const headers = new Headers(request.headers);
		for (const name of [
			"host",
			"x-origin-auth",
			"x-client-ip",
			"x-forwarded-host",
			"x-forwarded-proto",
			"x-cf-ray",
		])
			headers.delete(name);
		headers.set("x-origin-auth", env.ORIGIN_AUTH);
		headers.set("x-client-ip", request.headers.get("cf-connecting-ip") ?? "");
		headers.set("x-forwarded-host", url.host);
		headers.set("x-forwarded-proto", "https");
		// Cloudflare gives this Worker's call to the origin a new CF-Ray, so the visitor's ray travels as X-CF-Ray.
		headers.set("x-cf-ray", ray);

		// Copy the fixed origin and set only path and query. Resolving the path as a relative URL would let a
		// path like "//evil.example/x" send the request (and the secret) to another host.
		const target = new URL(env.ORIGIN);
		target.pathname = url.pathname;
		target.search = url.search;

		const line = (level, status, extra) =>
			console.log(
				JSON.stringify({
					time: new Date().toISOString(),
					level,
					app: "helphive",
					part: "edge",
					event: "request",
					ray,
					msg: "forwarded to origin",
					method: request.method,
					route: routeOf(url.pathname),
					status,
					ms: Date.now() - started,
					...extra,
				}),
			);

		try {
			const response = await fetch(target, {
				method: request.method,
				headers,
				body: request.body,
				redirect: "manual",
			});
			const quiet = request.method === "OPTIONS" || PROBES.has(url.pathname);
			line(response.status >= 500 ? "error" : quiet ? "debug" : "info", response.status);
			return response;
		} catch (err) {
			line("error", 502, { event: "exception", msg: "origin unreachable", error: err?.name ?? "Error" });
			throw err;
		}
	},
};
