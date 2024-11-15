import express from "express";
import {
	handleCreateBooking,
	handleCreatePaymentIntent,
	handleGetUserBookings,
	handleGetBookingById,
	handleApproveStartJobRequest,
} from "../../controllers/user-controllers/user.controller";
import { validateCreateBookingFields } from "../../controllers/validators/user.validators";

const userRoute = express.Router();

userRoute.post("/create-booking", validateCreateBookingFields, handleCreateBooking, handleCreatePaymentIntent);
userRoute.post("/create-payment-intent", handleCreatePaymentIntent);
userRoute.get("/bookings", handleGetUserBookings);
userRoute.post("/get-booking-by-id", handleGetBookingById);
userRoute.post("/approve-start-job-request", handleApproveStartJobRequest);

export default userRoute;
