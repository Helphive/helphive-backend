// CometChat settings, all from the environment (nothing secret in code). See .env.example and
// scratch/chat/cometchat-dashboard-steps.md. Read on each call so tests can pass their own environment.
//
// While COMETCHAT_APP_ID, COMETCHAT_REGION or COMETCHAT_REST_API_KEY is unset, chat is "not configured": the chat
// endpoints answer 503 chat_not_configured, nothing is sent to CometChat, and bookings and sign-in work as usual.

export const CHAT_REGIONS = ["us", "eu", "in"] as const;

/** CometChat role for every customer and provider; its permissions (friends-only messaging) are set in the dashboard. */
export const CHAT_MEMBER_ROLE = "default";
/** Role given to a user whose chat an admin suspended (every permission denied in the dashboard). */
export const CHAT_SUSPENDED_ROLE = "hh_chat_suspended";

const DEFAULT_ATTACHMENT_TYPES = [
	"image/jpeg",
	"image/png",
	"image/webp",
	"image/gif",
	"image/heic",
	"image/heif",
	"application/pdf",
];

const intIn = (value: string | undefined, fallback: number, min: number, max: number) => {
	const parsed = Number.parseInt(value ?? "", 10);
	return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** The shortest webhook password accepted (CometChat allows up to 100 alphanumeric characters). */
export const MIN_WEBHOOK_PASSWORD = 24;

export const chatConfig = (env: NodeJS.ProcessEnv = process.env) => {
	const appId = env.COMETCHAT_APP_ID?.trim() ?? "";
	const region = env.COMETCHAT_REGION?.trim().toLowerCase() ?? "";
	// COMET_CHAT_REST_API_KEY is the name already set on Cloud Run; the new name wins when both are set.
	const restApiKey = env.COMETCHAT_REST_API_KEY?.trim() || env.COMET_CHAT_REST_API_KEY?.trim() || "";
	const validAppId = /^[a-z0-9]{6,64}$/i.test(appId);
	const validRegion = (CHAT_REGIONS as readonly string[]).includes(region);
	const webhookUsername = env.COMETCHAT_WEBHOOK_USERNAME?.trim() ?? "";
	const webhookPassword = env.COMETCHAT_WEBHOOK_PASSWORD?.trim() ?? "";
	const attachmentTypes = env.CHAT_ATTACHMENT_TYPES?.trim()
		? env.CHAT_ATTACHMENT_TYPES.split(",")
				.map((type) => type.trim().toLowerCase())
				.filter(Boolean)
		: DEFAULT_ATTACHMENT_TYPES;
	return {
		appId,
		region,
		restApiKey,
		configured: validAppId && validRegion && !!restApiKey,
		baseUrl: validAppId && validRegion ? `https://${appId.toLowerCase()}.api-${region}.cometchat.io/v3` : "",
		/** Days a customer and provider may still chat after their last shared booking was completed or cancelled. */
		graceMs: intIn(env.CHAT_GRACE_DAYS, 7, 0, 90) * DAY_MS,
		/** Days a chat report (with the reported message's copy) is kept before it is deleted. */
		retentionMs: intIn(env.CHAT_RETENTION_DAYS, 365, 30, 3650) * DAY_MS,
		webhook: {
			username: webhookUsername,
			password: webhookPassword,
			configured: !!webhookUsername && webhookPassword.length >= MIN_WEBHOOK_PASSWORD,
		},
		attachments: {
			maxBytes: intIn(env.CHAT_ATTACHMENT_MAX_MB, 10, 1, 100) * 1024 * 1024,
			types: attachmentTypes,
		},
		/** Delete messages that break the rules (outside a booking relationship, disallowed attachment). Default on. */
		enforceOnWebhook: env.CHAT_WEBHOOK_ENFORCE?.trim().toLowerCase() !== "false",
		/** Push a OneSignal notification for new messages (lib/push.ts rules). Default on. */
		push: env.CHAT_PUSH?.trim().toLowerCase() !== "false",
		/** Sender's first name and a short preview of the text in the push; false: no message text at all. */
		pushPreview: env.CHAT_PUSH_PREVIEW?.trim().toLowerCase() !== "false",
		/** At most one push per conversation per receiver in this many seconds (the device collapses the rest). */
		pushMinIntervalMs: intIn(env.CHAT_PUSH_MIN_INTERVAL_SECONDS, 30, 0, 3600) * 1000,
	};
};

export type ChatConfig = ReturnType<typeof chatConfig>;
