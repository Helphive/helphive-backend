// Reading the audit log (permission audit.read). There is no write, update or delete endpoint.
import { Request, Response } from "express";
import mongoose from "mongoose";
import AuditLogModel from "../../dal/models/auditLog.model";
import { AUDIT_ACTIONS } from "../../lib/audit";
import { ListQueryError, escapeRegex, parseListQuery, runListQuery, type ListSpec } from "../../lib/listQuery";
import log from "../../lib/logger";

const ACTION = /^[a-z_]+(\.[a-z_]+)*\.?$/;

export const AUDIT_LIST_SPEC: ListSpec = {
	sortable: { at: "at", action: "action" },
	defaultSort: "-at",
	filters: {
		// Admin id, or an email (exact, case-insensitive).
		actor: {
			type: "custom",
			parse: (value) => {
				if (/^[a-f\d]{24}$/i.test(value)) return { "actor.id": new mongoose.Types.ObjectId(value) };
				if (value.length <= 255 && value.includes("@")) {
					return { "actor.email": { $regex: `^${escapeRegex(value)}$`, $options: "i" } };
				}
				return null;
			},
		},
		// Exact action ("admins.disabled") or a prefix ending in a dot ("admins.").
		action: {
			type: "custom",
			parse: (value) => {
				if (!ACTION.test(value) || value.length > 100) return null;
				return value.endsWith(".") ? { action: { $regex: `^${escapeRegex(value)}` } } : { action: value };
			},
		},
		targetType: { type: "string", path: "target.type", maxLength: 50 },
		targetId: { type: "string", path: "target.id", maxLength: 64 },
		outcome: { type: "enum", path: "outcome", values: ["success", "failure"] },
	},
	dateField: "at",
	maxPageSize: 100,
};

/** GET /admin/audit */
export const handleListAudit = async (req: Request, res: Response) => {
	try {
		const parsed = parseListQuery(req.query as Record<string, unknown>, AUDIT_LIST_SPEC);
		res.json(await runListQuery(AuditLogModel, parsed));
	} catch (error) {
		if (error instanceof ListQueryError)
			return res.status(400).json({ message: error.message, field: error.field });
		log.error("listing_audit_entries_failed", "Error listing audit entries", error);
		res.status(500).json({ message: "Internal server error" });
	}
};

/** GET /admin/audit/:id */
export const handleGetAuditEntry = async (req: Request, res: Response) => {
	try {
		const entry = await AuditLogModel.findById(req.params.id).lean().exec();
		if (!entry) return res.status(404).json({ message: "Audit entry not found." });
		res.json({ entry, description: AUDIT_ACTIONS[entry.action as keyof typeof AUDIT_ACTIONS] ?? null });
	} catch (error) {
		log.error("getting_audit_entry_failed", "Error getting audit entry", error);
		res.status(500).json({ message: "Internal server error" });
	}
};

/** GET /admin/audit/actions: every action name with its description. */
export const handleListAuditActions = (_req: Request, res: Response) => res.json({ actions: AUDIT_ACTIONS });
