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
} from "../controllers/auth.controller";

import { createContact, sendMagicLinkEmail } from "../controllers/email.controller";

import userRoute from "./user-routes/user.route";
import providerRoute from "./user-routes/provider.route";

import {
	validateSignupFields,
	validateLoginFields,
	validateResetPasswordFields,
} from "../controllers/validators/auth.validators";

import { verifyJWT } from "../middleware/verifyJWT";
import { verifyRoles } from "../middleware/verfiyRoles";

const authRoute = express.Router();

authRoute.post("/signup", validateSignupFields, handleSignup, createContact, sendMagicLinkEmail);
authRoute.post("/provider-signup", validateSignupFields, handleSignupProvider, createContact, sendMagicLinkEmail);
authRoute.post("/login", validateLoginFields, handleLogin);
authRoute.post("/logout", handleLogout);
authRoute.post("/refresh", handleRefreshToken);
authRoute.get("/user-info", verifyJWT, verifyRoles("User", "Provider"), handleGetUserInfo);
authRoute.get("/verify-email", handleVerifyEmail);
authRoute.post("/reset-password", validateResetPasswordFields, handleResetPassword);
authRoute.use("/reset-password", express.static(path.join(__dirname, "..", "views", "Reset Password")));
authRoute.use("/user", verifyJWT, verifyRoles("User"), userRoute);
authRoute.use("/provider", verifyJWT, verifyRoles("Provider"), providerRoute);
authRoute.post("/complete-booking", verifyJWT, verifyRoles("User", "Provider"), handleCompleteBooking);
authRoute.post("/cancel-booking", verifyJWT, verifyRoles("User", "Provider"), handleCancelBooking);

export default authRoute;
