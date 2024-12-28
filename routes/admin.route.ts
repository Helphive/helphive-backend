import express from "express";
import {
	handleLogin,
	handleSignup,
	handleLogout,
	handleRefreshToken,
	handleGetProviderAccountRequests,
	handleUpdateProviderAccountRequestStatus,
	handleGetProviderAccountRequestsComplete,
} from "../controllers/admin.controller.";
import { validateSignupFields, validateLoginFields } from "../controllers/user-controllers/validators/auth.validators";

const adminRoute = express.Router();

adminRoute.post("/signup", validateSignupFields, handleSignup);
adminRoute.post("/login", validateLoginFields, handleLogin);
adminRoute.post("/logout", validateLoginFields, handleLogout);
adminRoute.post("/refresh", handleRefreshToken);
adminRoute.get("/provider-account-requests", handleGetProviderAccountRequests);
adminRoute.get("/provider-account-requests-complete", handleGetProviderAccountRequestsComplete);
adminRoute.post("/update-provider-account-request-status", handleUpdateProviderAccountRequestStatus);

export default adminRoute;
