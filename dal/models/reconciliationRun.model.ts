import mongoose, { Schema, Types } from "mongoose";
import { MISMATCH_CATEGORIES, MISMATCH_TYPES } from "../../lib/reconciliation";

// One document per reconciliation run (lib/reconciliation.ts): who ran it, the range, what was checked, the totals on
// both sides and every mismatch found. Mismatches are embedded (a run keeps at most MAX_STORED_MISMATCHES); an admin
// can mark one explained with a note, which is audited.
export const MAX_STORED_MISMATCHES = 2000;

const mismatchSchema = new Schema(
	{
		key: { type: String, required: true },
		category: { type: String, enum: MISMATCH_CATEGORIES, required: true },
		type: { type: String, enum: MISMATCH_TYPES, required: true },
		explanation: { type: String },
		stripe: { type: Schema.Types.Mixed, default: null },
		db: { type: Schema.Types.Mixed, default: null },
		difference: { type: Number, default: null },
		bookingId: { type: String, default: null },
		explained: {
			type: new Schema(
				{
					at: { type: Date, required: true },
					by: { id: { type: Schema.Types.ObjectId }, email: { type: String } },
					note: { type: String, required: true },
				},
				{ _id: false },
			),
			default: null,
		},
	},
	{ _id: true },
);

export interface ReconciliationRunDoc {
	_id: Types.ObjectId;
	status: "running" | "completed" | "partial" | "failed";
	startedAt: Date;
	finishedAt?: Date | null;
	durationMs?: number | null;
	by: { id: Types.ObjectId; email: string };
	range: { from: Date; to: Date };
	checked: Record<string, unknown>;
	counts: { total: number; byType: Record<string, number>; byCategory: Record<string, number>; explained: number };
	totals: { stripe: Record<string, number>; db: Record<string, number> };
	mismatches: any[];
	truncated: boolean;
	notes: string[];
	error?: string | null;
	feePercent: number;
}

const runSchema = new Schema<ReconciliationRunDoc>(
	{
		status: { type: String, enum: ["running", "completed", "partial", "failed"], required: true },
		startedAt: { type: Date, required: true },
		finishedAt: { type: Date, default: null },
		durationMs: { type: Number, default: null },
		by: { id: { type: Schema.Types.ObjectId, ref: "Admin" }, email: { type: String } },
		range: { from: { type: Date, required: true }, to: { type: Date, required: true } },
		checked: { type: Schema.Types.Mixed, default: {} },
		counts: { type: Schema.Types.Mixed, default: {} },
		totals: { type: Schema.Types.Mixed, default: {} },
		mismatches: { type: [mismatchSchema], default: [] } as any,
		truncated: { type: Boolean, default: false },
		notes: { type: [String], default: [] },
		error: { type: String, default: null },
		feePercent: { type: Number },
	},
	{ timestamps: true, collection: "reconciliationruns", minimize: false },
);

runSchema.index({ startedAt: -1 });

const ReconciliationRunModel = mongoose.model<ReconciliationRunDoc>("ReconciliationRun", runSchema);

export default ReconciliationRunModel;
