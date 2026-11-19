import express from "express";
import {
	handleLogin,
	handleLogout,
	handleSignup,
	handleGetAccount,
	handleGetProviderAccountRequests,
	handleUpdateProviderAccountRequestStatus,
	handleGetProviderAccountRequestsComplete,
} from "../controllers/admin.controller";
import { validateSignupFields, validateLoginFields } from "../controllers/user-controllers/validators/auth.validators";
import { validateUpdateProviderAccountRequestStatus } from "../controllers/user-controllers/validators/admin.validators";
import { verifyAdminJWT } from "../middleware/verifyAdminJWT";
import { adminLoginLimiters } from "../middleware/rateLimit";

const adminRoute = express.Router();

// Preflight is answered by the app-wide CORS middleware, which only allows the known admin origins.

// Only a signed-in admin can create another admin. This route used to be open to anyone.
adminRoute.post("/signup", verifyAdminJWT, validateSignupFields, handleSignup);
adminRoute.post("/login", ...adminLoginLimiters, validateLoginFields, handleLogin);
adminRoute.post("/logout", verifyAdminJWT, handleLogout);
adminRoute.get("/account", verifyAdminJWT, handleGetAccount);
adminRoute.get("/provider-account-requests", verifyAdminJWT, handleGetProviderAccountRequests);
adminRoute.get("/provider-account-requests-complete", verifyAdminJWT, handleGetProviderAccountRequestsComplete);
adminRoute.post(
	"/update-provider-account-request-status",
	verifyAdminJWT,
	validateUpdateProviderAccountRequestStatus,
	handleUpdateProviderAccountRequestStatus,
);

export default adminRoute;
