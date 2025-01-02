import express from "express";
import {
	handleLogin,
	handleSignup,
	handleGetAccount,
	handleGetProviderAccountRequests,
	handleUpdateProviderAccountRequestStatus,
	handleGetProviderAccountRequestsComplete,
} from "../controllers/admin.controller";
import { validateSignupFields, validateLoginFields } from "../controllers/user-controllers/validators/auth.validators";
import { verifyAdminJWT } from "../middleware/verifyAdminJWT";

const adminRoute = express.Router();

adminRoute.options("*", (req, res) => {
	res.header("Access-Control-Allow-Origin", "*");
	res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
	res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, x-auth-token");
	res.sendStatus(200);
});

adminRoute.post("/signup", validateSignupFields, handleSignup);
adminRoute.post("/login", validateLoginFields, handleLogin);
adminRoute.get("/account", verifyAdminJWT, handleGetAccount);
adminRoute.get("/provider-account-requests", verifyAdminJWT, handleGetProviderAccountRequests);
adminRoute.get("/provider-account-requests-complete", verifyAdminJWT, handleGetProviderAccountRequestsComplete);
adminRoute.post("/update-provider-account-request-status", verifyAdminJWT, handleUpdateProviderAccountRequestStatus);

export default adminRoute;
