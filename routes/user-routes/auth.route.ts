import express from "express";
import path from "path";

import {
	handleLogin,
	handleSignup,
	handleSignupProvider,
	handleLogout,
	handleRefreshToken,
	handleGetUserInfo,
	handleVerifyEmail,
	handleResetPassword,
	handleCompleteBooking,
	handleCancelBooking,
	handleUpdateProfile,
	handleGetNotifications,
	handleMarkNotificationAsRead,
	handleGetUnreadNotificationCount,
	handleMarkAllNotificationsAsRead,
	handleDeleteNotification,
	handleGetBookingReceipt,
} from "../../controllers/user-controllers/auth.controller";

import { markSignupFlow, sendMagicLinkEmail } from "../../controllers/email.controller";

import userRoute from "./user.route";
import providerRoute from "./provider.route";
import placesRoute from "./places.route";
import chatRoute from "./chat.route";
import pushRoute from "./push.route";

import {
	validateSignupFields,
	validateLoginFields,
	validateResetPasswordFields,
	validateUpdateProfileFields,
} from "../../controllers/user-controllers/validators/auth.validators";

import { verifyJWT } from "../../middleware/verifyJWT";
import { verifyRoles } from "../../middleware/verfiyRoles";
import { blockDemoAccounts } from "../../middleware/blockDemoAccounts";
import {
	bookingActionLimiter,
	loginLimiters,
	refreshLimiters,
	resetPasswordLimiter,
	signupLimiter,
	uploadLimiter,
	verifyEmailLimiter,
} from "../../middleware/rateLimit";
import { uploadFields } from "../../middleware/uploads";
import { rejectUndeliverableSignup } from "../../middleware/signupEmailCheck";
import { riskListGate } from "../../lib/risk/gate";

const authRoute = express.Router();

// Sign-up needs the verification email, so an address the email policy would never send to is refused (400) after
// the limiter and validation and before any account is created (lib/emailPolicy.ts).
authRoute.post(
	"/signup",
	signupLimiter,
	validateSignupFields,
	riskListGate("signup"),
	rejectUndeliverableSignup("customer"),
	handleSignup,
	markSignupFlow,
	sendMagicLinkEmail,
);
authRoute.post(
	"/provider-signup",
	signupLimiter,
	validateSignupFields,
	riskListGate("signup"),
	rejectUndeliverableSignup("provider"),
	handleSignupProvider,
	markSignupFlow,
	sendMagicLinkEmail,
);
authRoute.post("/login", ...loginLimiters, validateLoginFields, riskListGate("signin"), handleLogin);
authRoute.post("/logout", handleLogout);
authRoute.post("/refresh", ...refreshLimiters, handleRefreshToken);
authRoute.get("/user-info", verifyJWT, verifyRoles("User", "Provider"), handleGetUserInfo);
authRoute.get("/verify-email", verifyEmailLimiter, handleVerifyEmail);
authRoute.post("/reset-password", resetPasswordLimiter, validateResetPasswordFields, handleResetPassword);
authRoute.use("/reset-password", express.static(path.join(__dirname, "..", "..", "views", "Reset Password")));
authRoute.use("/user", verifyJWT, verifyRoles("User"), userRoute);
authRoute.use("/provider", verifyJWT, verifyRoles("Provider"), providerRoute);
// Address lookup, chat and push registration: each route authenticates itself (verifyJWT + roles), so the guards are visible per route.
authRoute.use("/places", placesRoute);
authRoute.use("/chat", chatRoute);
authRoute.use("/push", pushRoute);
authRoute.post(
	"/complete-booking",
	verifyJWT,
	verifyRoles("User", "Provider"),
	bookingActionLimiter,
	handleCompleteBooking,
);
authRoute.post(
	"/cancel-booking",
	verifyJWT,
	verifyRoles("User", "Provider"),
	bookingActionLimiter,
	handleCancelBooking,
);
authRoute.post(
	"/profile",
	verifyJWT,
	verifyRoles("User", "Provider"),
	blockDemoAccounts,
	uploadLimiter,
	uploadFields(["profile"]),
	validateUpdateProfileFields,
	handleUpdateProfile,
);
authRoute.get("/notifications", verifyJWT, verifyRoles("User", "Provider"), handleGetNotifications);
authRoute.get(
	"/notifications/unread-count",
	verifyJWT,
	verifyRoles("User", "Provider"),
	handleGetUnreadNotificationCount,
);
authRoute.post(
	"/notifications/mark-all-read",
	verifyJWT,
	verifyRoles("User", "Provider"),
	handleMarkAllNotificationsAsRead,
);
authRoute.delete(
	"/notifications/:notificationId",
	verifyJWT,
	verifyRoles("User", "Provider"),
	handleDeleteNotification,
);
authRoute.get("/booking-receipt/:bookingId", verifyJWT, verifyRoles("User", "Provider"), handleGetBookingReceipt);
authRoute.post("/mark-notification-read", verifyJWT, verifyRoles("User", "Provider"), handleMarkNotificationAsRead);

export default authRoute;
