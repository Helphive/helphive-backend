import express from "express";
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
	handleCreatePayout,
	handleGetStripeExpressLoginLink,
	handleUpdateProviderAvailability,
} from "../../controllers/user-controllers/provider.controller";
import {
	validateBookingIdBody,
	validateCreatePayoutFields,
	validateRequestProviderAccountFields,
	validateUpdateProviderAvailability,
} from "../../controllers/user-controllers/validators/provider.validators";
import { blockDemoAccounts } from "../../middleware/blockDemoAccounts";
import { requireApprovedProvider } from "../../middleware/requireApprovedProvider";
import { bookingActionLimiter, payoutLimiter, uploadLimiter } from "../../middleware/rateLimit";
import { uploadFields } from "../../middleware/uploads";
import { markRouteBase } from "../../middleware/requestContext";

const providerRoute = express.Router();
providerRoute.use(markRouteBase);

providerRoute.post(
	"/request-provider-account",
	blockDemoAccounts,
	uploadLimiter,
	uploadFields(["id", "dbs", "resume", "profile"]),
	validateRequestProviderAccountFields,
	handleRequestProviderAccount,
);

providerRoute.put(
	"/update-provider-availability",
	requireApprovedProvider,
	validateUpdateProviderAvailability,
	handleUpdateProviderAvailability,
);
providerRoute.get("/account-approval-screen", handleAccountApprovalScreen);
providerRoute.get("/get-bookings", requireApprovedProvider, handleGetBookings);
providerRoute.post("/get-booking-by-id", requireApprovedProvider, handleGetBookingById);
providerRoute.post(
	"/accept-booking",
	requireApprovedProvider,
	bookingActionLimiter,
	validateBookingIdBody,
	handleAcceptBooking,
);
providerRoute.get("/my-orders", handleMyOrders);
providerRoute.post(
	"/start-booking",
	requireApprovedProvider,
	bookingActionLimiter,
	validateBookingIdBody,
	handleStartBooking,
);
providerRoute.get("/stripe-connect-onboarding", blockDemoAccounts, handleGetStripeConnectedAccount);
providerRoute.get("/get-earnings", handleGetEarnings);
providerRoute.post("/create-payout", payoutLimiter, validateCreatePayoutFields, handleCreatePayout);
providerRoute.get("/stripe-express-login-link", blockDemoAccounts, handleGetStripeExpressLoginLink);

export default providerRoute;
