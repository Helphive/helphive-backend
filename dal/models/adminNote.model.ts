import mongoose, { Schema, Types } from "mongoose";

// Admin notes on a user, booking, payment or provider application. Only admins read them (they are never part of a
// customer or provider response). Deleting keeps the note with deletedAt set, so the history stays readable in the
// audit log and the note can be shown as "deleted" if needed.
export const NOTE_TARGET_TYPES = ["user", "booking", "payment", "application"] as const;
export type NoteTargetType = (typeof NOTE_TARGET_TYPES)[number];

export interface AdminNoteDoc {
	_id: Types.ObjectId;
	targetType: NoteTargetType;
	targetId: Types.ObjectId;
	body: string;
	author: { id: Types.ObjectId; email: string };
	createdAt: Date;
	updatedAt: Date;
	editedAt?: Date | null;
	deletedAt?: Date | null;
	deletedBy?: Types.ObjectId | null;
}

const adminNoteSchema = new Schema<AdminNoteDoc>(
	{
		targetType: { type: String, enum: NOTE_TARGET_TYPES, required: true },
		targetId: { type: Schema.Types.ObjectId, required: true },
		body: { type: String, required: true, minlength: 1, maxlength: 2000 },
		author: {
			id: { type: Schema.Types.ObjectId, ref: "Admin", required: true },
			email: { type: String, required: true },
		},
		editedAt: { type: Date, default: null },
		deletedAt: { type: Date, default: null },
		deletedBy: { type: Schema.Types.ObjectId, ref: "Admin", default: null },
	},
	{ timestamps: true, collection: "adminnotes" },
);

// A record's notes, newest first.
adminNoteSchema.index({ targetType: 1, targetId: 1, createdAt: -1 });

const AdminNoteModel = mongoose.model<AdminNoteDoc>("AdminNote", adminNoteSchema);

export default AdminNoteModel;
