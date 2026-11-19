// Platform settings for the console (read by every role, changed with settings.manage) and the public endpoints the
// web and mobile apps fetch (the announcement banner and the services offered).
import type { Request, Response } from "express";
import PlatformSettingModel from "../../dal/models/platformSetting.model";
import {
	DEFAULT_SETTINGS,
	SETTING_DEFINITIONS,
	SETTING_GROUPS,
	SETTING_KEYS,
	activeAnnouncement,
	getSettings,
	invalidateSettings,
	isSettingKey,
	mergeStoredSettings,
	stripeModeOf,
	testModeNotice,
	validateSettingValue,
	type SettingKey,
} from "../../lib/settings";
import { adminActor, recordAudit } from "../../lib/audit";
import { emitEvent } from "../../lib/events";
import { DETAIL_TIME_LIMIT_MS, answerError } from "./operations.shared";

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Stripe mode and the earnings delay, for the console's test-mode notice. */
export const runtimeInfo = (delaySeconds: number) => {
	const stripeMode = stripeModeOf(process.env.STRIPE_SECRET_KEY);
	return {
		stripeMode,
		earningsReleaseDelaySeconds: delaySeconds,
		notice: stripeMode === "live" ? null : testModeNotice(delaySeconds),
	};
};

/** GET /admin/settings */
export const handleGetSettings = async (_req: Request, res: Response) => {
	try {
		const docs = await PlatformSettingModel.find({}).maxTimeMS(DETAIL_TIME_LIMIT_MS).lean().exec();
		const byKey = new Map(docs.map((d) => [d.key, d]));
		// Read fresh here (not from the cache), so the console shows exactly what is stored.
		const current = mergeStoredSettings(Object.fromEntries(docs.map((d) => [d.key, d.value])));
		res.json({
			groups: Object.entries(SETTING_GROUPS).map(([id, label]) => ({ id, label })),
			settings: SETTING_KEYS.map((key) => {
				const def = SETTING_DEFINITIONS[key];
				const doc = byKey.get(key);
				return {
					key,
					group: def.group,
					label: def.label,
					affects: def.affects,
					kind: def.kind,
					unit: def.unit ?? null,
					min: def.min ?? null,
					max: def.max ?? null,
					decimals: def.decimals ?? null,
					value: current[key],
					default: DEFAULT_SETTINGS[key],
					isDefault: sameValue(current[key], DEFAULT_SETTINGS[key]),
					version: doc?.version ?? 0,
					updatedAt: doc?.updatedAt ?? null,
					updatedBy: doc?.updatedBy?.email
						? { id: String(doc.updatedBy.id), email: doc.updatedBy.email }
						: null,
				};
			}),
			runtime: runtimeInfo(current["payments.earningsReleaseDelaySeconds"]),
		});
	} catch (error) {
		answerError(res, error, "reading settings");
	}
};

/** PATCH /admin/settings/:key { value, reason, expectedVersion? } */
export const handleUpdateSetting = async (req: Request, res: Response) => {
	try {
		const key = req.params.key;
		if (!isSettingKey(key)) return res.status(404).json({ message: "Unknown setting." });
		if (!Object.prototype.hasOwnProperty.call(req.body ?? {}, "value"))
			return res.status(400).json({ message: "Give the new value.", field: "value" });
		const docs = await PlatformSettingModel.find({}).maxTimeMS(DETAIL_TIME_LIMIT_MS).lean().exec();
		const current = mergeStoredSettings(Object.fromEntries(docs.map((d) => [d.key, d.value])));
		const doc = docs.find((d) => d.key === key);
		const version = doc?.version ?? 0;
		if (req.body.expectedVersion !== undefined && req.body.expectedVersion !== version) {
			return res.status(409).json({
				message: "Someone changed this setting meanwhile. Reload to see the current value.",
				code: "setting_changed",
			});
		}
		const result = validateSettingValue(key as SettingKey, req.body.value, current);
		if (!result.ok) return res.status(400).json({ message: result.message, field: "value" });
		const before = current[key as SettingKey];
		if (sameValue(before, result.value)) return res.status(409).json({ message: "That is already the value." });

		const by = { id: req.admin!._id, email: req.admin!.email };
		const updated = doc
			? await PlatformSettingModel.findOneAndUpdate(
					{ key, version },
					{ $set: { value: result.value, version: version + 1, updatedBy: by } },
					{ new: true },
				).exec()
			: await PlatformSettingModel.create({ key, value: result.value, version: 1, updatedBy: by }).catch(
					(error: any) => {
						if (error?.code === 11000) return null;
						throw error;
					},
				);
		if (!updated) {
			return res.status(409).json({
				message: "Someone changed this setting meanwhile. Reload to see the current value.",
				code: "setting_changed",
			});
		}
		invalidateSettings();
		await recordAudit(
			{
				action: "settings.updated",
				actor: adminActor(req),
				target: { type: "setting", id: key },
				before: { [key]: before },
				after: { [key]: result.value },
				reason: String(req.body.reason),
				metadata: {
					version: version + 1,
					isDefault: sameValue(result.value, DEFAULT_SETTINGS[key as SettingKey]),
				},
			},
			req,
		);
		emitEvent(
			{
				type: "settings.changed",
				actor: { type: "admin", id: req.admin!._id },
				properties: { key, before, after: result.value },
			},
			req,
		);
		res.json({
			key,
			value: result.value,
			before,
			version: version + 1,
			note: "Other server instances pick this up within 30 seconds.",
		});
	} catch (error) {
		answerError(res, error, "updating a setting");
	}
};

const AUDIENCES = ["customers", "providers", "all"] as const;

/** GET /public/announcement?audience=customers|providers : the banner to show now, or null. Cached for a minute. */
export const handlePublicAnnouncement = async (req: Request, res: Response) => {
	try {
		const audience = (
			typeof req.query.audience === "string" ? req.query.audience : "all"
		) as (typeof AUDIENCES)[number];
		if (!AUDIENCES.includes(audience))
			return res.status(400).json({ message: "audience must be customers, providers or all." });
		const settings = await getSettings();
		const banner = activeAnnouncement(settings["announcements.banner"], audience, new Date());
		res.set("Cache-Control", "public, max-age=60");
		res.json({
			announcement: banner
				? {
						text: banner.text,
						tone: banner.tone,
						audience: banner.audience,
						startsAt: banner.startsAt,
						endsAt: banner.endsAt,
					}
				: null,
		});
	} catch (error) {
		answerError(res, error, "reading the announcement");
	}
};

/** GET /public/services : the services offered, with names and descriptions. Cached for a minute. */
export const handlePublicServices = async (_req: Request, res: Response) => {
	try {
		const settings = await getSettings();
		res.set("Cache-Control", "public, max-age=60");
		res.json({ services: settings["services.catalogue"].filter((s) => s.active) });
	} catch (error) {
		answerError(res, error, "reading the services");
	}
};
