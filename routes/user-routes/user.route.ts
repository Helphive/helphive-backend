import express from "express";
import {
	handleCreateBooking,
	handleCreatePaymentIntent,
	handleGetUserBookings,
	handleGetBookingById,
	handleApproveStartJobRequest,
} from "../../controllers/user-controllers/user.controller";
import {
	validateBookingIdField,
	validateCreateBookingFields,
} from "../../controllers/user-controllers/validators/user.validators";
import { bookingActionLimiter, createBookingLimiter, paymentIntentLimiter } from "../../middleware/rateLimit";

const userRoute = express.Router();

userRoute.post(
	"/create-booking",
	createBookingLimiter,
	validateCreateBookingFields,
	handleCreateBooking,
	handleCreatePaymentIntent,
);
// Payment for an existing booking of the caller's (no client calls this today; create-booking does both steps).
userRoute.post("/create-payment-intent", paymentIntentLimiter, validateBookingIdField, handleCreatePaymentIntent);
userRoute.get("/bookings", handleGetUserBookings);
userRoute.post("/get-booking-by-id", handleGetBookingById);
userRoute.post("/approve-start-job-request", bookingActionLimiter, handleApproveStartJobRequest);

export default userRoute;
