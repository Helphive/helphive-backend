import mongoose, { Schema, Document } from "mongoose";

export interface Booking extends Document {
	status: "pending" | "in progress" | "completed" | "cancelled";
	providerId: mongoose.Types.ObjectId | null;
	userId: mongoose.Types.ObjectId;
	service: {
		id: number;
		name: string;
	};
	rate: number;
	hours: number;
	startDate: Date;
	/** When a provider accepted (set from the accept endpoint; absent on bookings accepted before it existed). */
	acceptedAt: Date | null;
	/** When the provider asked the customer to approve the start. */
	startRequestedAt: Date | null;
	startedAt: Date;
	completedAt: Date;
	completedBy: mongoose.Types.ObjectId;
	cancelledAt: Date;
	cancelledBy: mongoose.Types.ObjectId;
	userApprovalRequested: boolean;
	address: string;
	latitude: number;
	longitude: number;
	createdAt: Date;
	updatedAt: Date;
	cancellationReason: string;
}

const bookingSchema: Schema = new Schema(
	{
		status: {
			type: String,
			enum: ["pending", "in progress", "completed", "cancelled"],
			default: "pending",
		},
		providerId: {
			type: mongoose.Types.ObjectId,
			ref: "User",
			default: null,
		},
		userId: {
			type: mongoose.Types.ObjectId,
			ref: "User",
			required: true,
		},
		service: {
			id: {
				type: Number,
				required: true,
			},
			name: {
				type: String,
			},
		},
		rate: {
			type: Number,
			required: true,
		},
		hours: {
			type: Number,
			required: true,
		},
		startDate: {
			type: Date,
			required: true,
		},
		acceptedAt: {
			type: Date,
			default: null,
		},
		startRequestedAt: {
			type: Date,
			default: null,
		},
		startedAt: {
			type: Date,
			default: null,
		},
		completedAt: {
			type: Date,
			default: null,
		},
		completedBy: {
			type: mongoose.Types.ObjectId,
			ref: "User",
			default: null,
		},
		cancelledAt: {
			type: Date,
			default: null,
		},
		cancelledBy: {
			type: mongoose.Types.ObjectId,
			ref: "User",
			default: null,
		},
		userApprovalRequested: {
			type: Boolean,
			default: false,
		},
		address: {
			type: String,
			required: true,
		},
		latitude: {
			type: Number,
			required: true,
		},
		longitude: {
			type: Number,
			required: true,
		},
		cancellationReason: {
			type: String,
		},
	},
	{ timestamps: true },
);

// App queries (a customer's or provider's bookings, open jobs) and admin lists (by status and dates).
bookingSchema.index({ userId: 1, createdAt: -1 });
bookingSchema.index({ providerId: 1, startDate: -1 });
bookingSchema.index({ status: 1, providerId: 1, startDate: 1 });
bookingSchema.index({ status: 1, createdAt: -1 });
bookingSchema.index({ createdAt: -1 });
bookingSchema.index({ startDate: -1 });

bookingSchema.pre<Booking>("save", function (next) {
	const service = this.service;
	if (service && service.id) {
		if (service.id === 1) {
			service.name = "Public Area Attendant";
		} else if (service.id === 2) {
			service.name = "Room Attendant";
		} else if (service.id === 3) {
			service.name = "Linen Porter";
		}
	}
	next();
});

const BookingModel = mongoose.model<Booking>("Booking", bookingSchema);

export default BookingModel;
