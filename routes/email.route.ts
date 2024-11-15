import express from "express";
import { sendMagicLinkEmail, sendResetPasswordEmail } from "../controllers/email.controller";

const emailRoute = express.Router();

emailRoute.post("/get-email-verification", sendMagicLinkEmail);
emailRoute.post("/get-password-reset", sendResetPasswordEmail);

export default emailRoute;
