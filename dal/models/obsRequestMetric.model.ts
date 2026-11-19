import mongoose, { Schema } from "mongoose";

// Request metrics: one document per minute, route pattern, method and revision, merged across Cloud Run instances
// by $inc (lib/observability/requestMetrics.ts). Short field names keep each document about 200 bytes.
// Removed at `expireAt` (OBS_METRICS_RETENTION_DAYS after the minute, default 30).
export interface RequestMetricDoc {
	/** Start of the minute (UTC). */
	m: Date;
	/** Route pattern ("/admin/users/:id"), "(unmatched)" for 404s outside any route. */
	r: string;
	mt: string;
	/** Cloud Run revision (K_REVISION), "local" elsewhere. */
	rv: string;
	n: number;
	s2: number;
	s3: number;
	s4: number;
	s5: number;
	/** 429 answers (also counted in s4). */
	rl: number;
	/** Latency sum and maximum, milliseconds. */
	sum: number;
	max: number;
	/** Latency histogram: bucket index -> count (lib/observability/histogram.ts). */
	h: Record<string, number>;
	expireAt: Date;
}

const schema = new Schema<RequestMetricDoc>(
	{
		m: { type: Date, required: true },
		r: { type: String, required: true },
		mt: { type: String, required: true },
		rv: { type: String, required: true },
		n: { type: Number, default: 0 },
		s2: { type: Number, default: 0 },
		s3: { type: Number, default: 0 },
		s4: { type: Number, default: 0 },
		s5: { type: Number, default: 0 },
		rl: { type: Number, default: 0 },
		sum: { type: Number, default: 0 },
		max: { type: Number, default: 0 },
		h: { type: Schema.Types.Mixed, default: {} },
		expireAt: { type: Date, required: true },
	},
	{ versionKey: false, collection: "obsrequestmetrics", minimize: false },
);

schema.index({ m: 1, r: 1, mt: 1, rv: 1 }, { unique: true });
schema.index({ r: 1, mt: 1, m: 1 });
schema.index({ rv: 1, m: 1 });
schema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

const RequestMetricModel = mongoose.model<RequestMetricDoc>("ObsRequestMetric", schema);

export default RequestMetricModel;
