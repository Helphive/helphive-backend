import type { RequestHandler } from "express";
import type { AuditAction } from "../lib/audit";

/**
 * Marks a route handler with the audit actions it records, so tests/adminRoutes.test.ts can check that every admin
 * write route is audited (and that each action is a known one used in the controllers). Returns the same handler.
 */
export const audited = <H extends RequestHandler>(actions: readonly AuditAction[], handler: H): H => {
	(handler as H & { auditActions?: readonly AuditAction[] }).auditActions = actions;
	return handler;
};

export const auditActionsOf = (handler: unknown): readonly AuditAction[] | undefined =>
	(handler as { auditActions?: readonly AuditAction[] } | null)?.auditActions;
