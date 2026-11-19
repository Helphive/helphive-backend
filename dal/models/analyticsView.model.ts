import mongoose, { Schema, Types } from "mongoose";

// A saved analytics query: an admin's named Explorer view (metric, breakdown, range, interval, comparison, chart),
// private to its owner unless shared with every admin. Written only by controllers/admin/analytics.controller.ts.
export interface AnalyticsViewDoc {
	_id: Types.ObjectId;
	name: string;
	ownerId: Types.ObjectId;
	ownerEmail: string;
	shared: boolean;
	query: {
		metric: string;
		breakdown?: string | null;
		range?: string | null;
		from?: string | null;
		to?: string | null;
		interval?: string | null;
		compare?: string | null;
		stat?: string | null;
		chart?: string | null;
	};
	createdAt: Date;
	updatedAt: Date;
}

const analyticsViewSchema = new Schema<AnalyticsViewDoc>(
	{
		name: { type: String, required: true, maxlength: 80 },
		ownerId: { type: Schema.Types.ObjectId, ref: "Admin", required: true },
		ownerEmail: { type: String, required: true },
		shared: { type: Boolean, default: false },
		query: {
			_id: false,
			metric: { type: String, required: true },
			breakdown: { type: String, default: null },
			range: { type: String, default: null },
			from: { type: String, default: null },
			to: { type: String, default: null },
			interval: { type: String, default: null },
			compare: { type: String, default: null },
			stat: { type: String, default: null },
			chart: { type: String, default: null },
		},
	},
	{ timestamps: true, collection: "analyticsviews" },
);

// An admin's own views, and the shared ones.
analyticsViewSchema.index({ ownerId: 1, updatedAt: -1 });
analyticsViewSchema.index({ shared: 1, updatedAt: -1 }, { partialFilterExpression: { shared: true } });

const AnalyticsViewModel = mongoose.model<AnalyticsViewDoc>("AnalyticsView", analyticsViewSchema);

export default AnalyticsViewModel;
