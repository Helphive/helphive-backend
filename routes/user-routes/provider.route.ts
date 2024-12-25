import express from "express";
import multer from "multer";
import {
	handleRequestProviderAccount,
	handleAccountApprovalScreen,
	handleGetBookings,
	handleGetBookingById,
	handleAcceptBooking,
	handleMyOrders,
	handleStartBooking,
	handleGetStripeConnectedAccount,
	handleGetEarnings,
} from "../../controllers/user-controllers/provider.controller";
import { validateRequestProviderAccountFields } from "../../controllers/validators/provider.validators";

const upload = multer();

const providerRoute = express.Router();

providerRoute.post(
	"/request-provider-account",
	upload.fields([
		{ name: "id", maxCount: 1 },
		{ name: "dbs", maxCount: 1 },
		{ name: "resume", maxCount: 1 },
		{ name: "profile", maxCount: 1 },
	]),
	validateRequestProviderAccountFields,
	handleRequestProviderAccount,
);

providerRoute.get("/account-approval-screen", handleAccountApprovalScreen);
providerRoute.get("/get-bookings", handleGetBookings);
providerRoute.post("/get-booking-by-id", handleGetBookingById);
providerRoute.post("/accept-booking", handleAcceptBooking);
providerRoute.get("/my-orders", handleMyOrders);
providerRoute.post("/start-booking", handleStartBooking);
providerRoute.get("/stripe-connect-onboarding", handleGetStripeConnectedAccount);
providerRoute.get("/get-earnings", handleGetEarnings);

export default providerRoute;
