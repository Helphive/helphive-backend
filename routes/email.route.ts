import express from "express";
import { sendMagicLinkEmail, sendResetPasswordEmail } from "../controllers/email.controller";
import { emailRequestLimiters } from "../middleware/rateLimit";

const emailRoute = express.Router();

emailRoute.post("/get-email-verification", ...emailRequestLimiters("verify"), sendMagicLinkEmail);
emailRoute.post("/get-password-reset", ...emailRequestLimiters("reset"), sendResetPasswordEmail);

export default emailRoute;
