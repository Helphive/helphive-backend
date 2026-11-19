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
	/** "HH-" plus the last 8 hex digits of the id, upper case: the receipt number. Set when a booking is created. */
	reference?: string;
	/**
	 * How the address was chosen (from the address picker; absent on older bookings and from older apps). `address`
	 * above is always the text people see: the customer's own text when they typed over the picked address, else the
	 * address the app sent. latitude/longitude stay those of the pin.
	 */
	location?: BookingLocation | null;
}

export const LOCATION_SOURCES = ["search", "map", "current_location"] as const;
export type LocationSource = (typeof LOCATION_SOURCES)[number];

export interface BookingLocation {
	/** Google place id of the picked place (search or reverse lookup). */
	placeId?: string | null;
	/** The address Google returned for it. */
	formattedAddress?: string | null;
	/** Hotel or venue name, when the place is one. */
	placeName?: string | null;
	source?: LocationSource | null;
	/** What the customer typed over the picked address; shown instead of it (and stored as `address`). */
	customAddress?: string | null;
	/** The `address` the app sent, kept when a custom text replaced it. */
	submittedAddress?: string | null;
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
		reference: {
			type: String,
		},
		location: {
			type: new Schema(
				{
					placeId: { type: String },
					formattedAddress: { type: String },
					placeName: { type: String },
					source: { type: String, enum: LOCATION_SOURCES },
					customAddress: { type: String },
					submittedAddress: { type: String },
				},
				{ _id: false },
			),
			default: undefined,
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
// Operations console: completed/cancelled today, lookup by receipt number, and the address prefix search
// (case-insensitive collation; queries must pass SEARCH_COLLATION).
bookingSchema.index({ status: 1, completedAt: -1 });
bookingSchema.index({ status: 1, cancelledAt: -1 });
bookingSchema.index({ reference: 1 }, { partialFilterExpression: { reference: { $exists: true } } });
bookingSchema.index({ address: 1 }, { name: "address_ci", collation: { locale: "en", strength: 2 } });

bookingSchema.pre<Booking>("save", function (next) {
	if (!this.reference && this._id) this.reference = `HH-${String(this._id).slice(-8).toUpperCase()}`;
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
