import mongoose, { Schema, Types } from "mongoose";

// One document per Cloud Tasks call this server received (earning release, booking expiry), with its outcome. The
// body is only a booking id, kept as `bookingId`, so a run can be replayed by posting the same body again.
export const TASK_OUTCOMES = ["processed", "skipped", "failed", "rejected"] as const;
export type TaskOutcome = (typeof TASK_OUTCOMES)[number];

export interface TaskRunDoc {
	_id: Types.ObjectId;
	task: string;
	taskName?: string | null;
	queue?: string | null;
	retryCount?: number | null;
	executionCount?: number | null;
	bookingId?: string | null;
	receivedAt: Date;
	processedAt: Date;
	durationMs: number;
	status: number;
	outcome: TaskOutcome;
	note?: string | null;
	error?: string | null;
	requestId?: string | null;
	/** Set on a run started from the console (observability replay): the run it repeated and who started it. */
	replayOf?: Types.ObjectId | null;
	replayedBy?: string | null;
}

const taskRunSchema = new Schema<TaskRunDoc>(
	{
		task: { type: String, required: true },
		taskName: { type: String, default: null },
		queue: { type: String, default: null },
		retryCount: { type: Number, default: null },
		executionCount: { type: Number, default: null },
		bookingId: { type: String, default: null },
		receivedAt: { type: Date, required: true },
		processedAt: { type: Date, required: true },
		durationMs: { type: Number, required: true },
		status: { type: Number, required: true },
		outcome: { type: String, enum: TASK_OUTCOMES, required: true },
		note: { type: String, default: null },
		error: { type: String, default: null },
		requestId: { type: String, default: null },
		replayOf: { type: Schema.Types.ObjectId, default: null },
		replayedBy: { type: String, default: null },
	},
	{ versionKey: false, collection: "taskruns" },
);

taskRunSchema.index({ receivedAt: -1 });
taskRunSchema.index({ task: 1, receivedAt: -1 });
taskRunSchema.index({ outcome: 1, receivedAt: -1 });
taskRunSchema.index({ bookingId: 1, receivedAt: -1 });

const TaskRunModel = mongoose.model<TaskRunDoc>("TaskRun", taskRunSchema);

export default TaskRunModel;
