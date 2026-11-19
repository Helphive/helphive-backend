// Push registration for signed-in customers and providers, mounted at /auth/push. Every route: authentication, a
// rate limit, then validation (tests/newRoutes.test.ts checks it).
import express from "express";
import { verifyJWT } from "../../middleware/verifyJWT";
import { verifyRoles } from "../../middleware/verfiyRoles";
import { pushRegisterLimiter } from "../../middleware/rateLimit";
import { handleRegisterPush, handleUnregisterPush } from "../../controllers/user-controllers/push.controller";
import { validateNoInput } from "../../controllers/user-controllers/validators/common.validators";

const pushRoute = express.Router();

const signedIn = [verifyJWT, verifyRoles("User", "Provider")];

pushRoute.post("/register", ...signedIn, pushRegisterLimiter, validateNoInput, handleRegisterPush);
pushRoute.delete("/register", ...signedIn, pushRegisterLimiter, validateNoInput, handleUnregisterPush);

export default pushRoute;
