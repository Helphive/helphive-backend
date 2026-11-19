// Request validation for the operations console routes. Each chain ends with rejectIfInvalid (400 { message }).
import { body, param } from "express-validator";
import { isValidObjectId } from "../user-controllers/utils/booking.utils";
import { rejectIfInvalid } from "../user-controllers/validators/common.validators";
import { NOTE_TARGET_TYPES } from "../../dal/models/adminNote.model";

const requiredReason = () =>
	body("reason")
		.isString()
		.withMessage("Give a reason (3 to 1000 characters).")
		.trim()
		.isLength({ min: 3, max: 1000 })
		.withMessage("Give a reason (3 to 1000 characters).");

const optionalReason = () =>
	body("reason")
		.optional({ values: "falsy" })
		.isString()
		.withMessage("Reason must be text.")
		.trim()
		.isLength({ max: 1000 })
		.withMessage("Reason must be at most 1000 characters.");

export const idParam = (label: string) => [
	param("id")
		.custom((value) => isValidObjectId(value))
		.withMessage(`Invalid ${label} id.`),
	rejectIfInvalid,
];

export const validateReason = [requiredReason(), rejectIfInvalid];
export const validateOptionalReason = [optionalReason(), rejectIfInvalid];

const noteBody = () =>
	body("body")
		.isString()
		.withMessage("Write the note (1 to 2000 characters).")
		.trim()
		.isLength({ min: 1, max: 2000 })
		.withMessage("Write the note (1 to 2000 characters).");

export const validateCreateNote = [
	body("targetType")
		.isIn(NOTE_TARGET_TYPES)
		.withMessage(`targetType must be one of: ${NOTE_TARGET_TYPES.join(", ")}.`),
	body("targetId")
		.custom((value) => isValidObjectId(value))
		.withMessage("Invalid targetId."),
	noteBody(),
	rejectIfInvalid,
];

export const validateUpdateNote = [noteBody(), optionalReason(), rejectIfInvalid];

export const validateCancelBooking = [
	body("onBehalfOf").isIn(["customer", "provider"]).withMessage("onBehalfOf must be customer or provider."),
	requiredReason(),
	rejectIfInvalid,
];

export const validateResolveBooking = [
	body("outcome").isIn(["completed", "cancelled"]).withMessage("outcome must be completed or cancelled."),
	body("refund").optional({ values: "undefined" }).isIn(["full", "none"]).withMessage("refund must be full or none."),
	body("confirm")
		.optional({ values: "undefined" })
		.isBoolean({ strict: true })
		.withMessage("confirm must be true or false."),
	requiredReason(),
	rejectIfInvalid,
];

export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,64}$/;

export const validateRefund = [
	body("amount")
		.optional({ values: "null" })
		.custom(
			(value) =>
				typeof value === "number" &&
				Number.isFinite(value) &&
				value > 0 &&
				value <= 1_000_000 &&
				Math.abs(value * 100 - Math.round(value * 100)) < 1e-6,
		)
		.withMessage("amount must be a number of dollars above zero with at most two decimals (omit it for the rest)."),
	body("idempotencyKey")
		.isString()
		.matches(IDEMPOTENCY_KEY)
		.withMessage("idempotencyKey must be 8 to 64 letters, digits, - or _ (one per refund dialog)."),
	requiredReason(),
	rejectIfInvalid,
];

export const validateResolveChatReport = [
	body("status").isIn(["actioned", "dismissed"]).withMessage("status must be actioned or dismissed."),
	requiredReason(),
	rejectIfInvalid,
];
