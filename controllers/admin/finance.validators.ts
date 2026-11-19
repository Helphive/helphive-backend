// Request validation for the finance, support and platform routes. Each chain ends with rejectIfInvalid (400 { message }).
import { body, param } from "express-validator";
import { isValidObjectId } from "../user-controllers/utils/booking.utils";
import { rejectIfInvalid } from "../user-controllers/validators/common.validators";
import {
	CASE_ACTION_TYPES,
	CASE_CATEGORIES,
	CASE_OUTCOMES,
	CASE_PRIORITIES,
	CASE_STATUSES,
} from "../../lib/supportCases";
import { IDEMPOTENCY_KEY } from "./operations.validators";

const text = (field: string, label: string, min: number, max: number) =>
	body(field)
		.isString()
		.withMessage(`${label} (${min} to ${max} characters).`)
		.trim()
		.isLength({ min, max })
		.withMessage(`${label} (${min} to ${max} characters).`);

const optionalReason = () =>
	body("reason")
		.optional({ values: "falsy" })
		.isString()
		.withMessage("Reason must be text.")
		.trim()
		.isLength({ max: 1000 })
		.withMessage("Reason must be at most 1000 characters.");

const optionalId = (field: string, label: string) =>
	body(field)
		.optional({ values: "null" })
		.custom((value) => isValidObjectId(value))
		.withMessage(`Invalid ${label} id.`);

export const mongoIdParam = (name: string, label: string) => [
	param(name)
		.custom((value) => isValidObjectId(value))
		.withMessage(`Invalid ${label} id.`),
	rejectIfInvalid,
];

export const validateRunReconciliation = [
	body("from").isString().withMessage("from is required (YYYY-MM-DD)."),
	body("to").optional().isString().withMessage("to must be a date (YYYY-MM-DD)."),
	rejectIfInvalid,
];

export const validateExplainMismatch = [
	param("mismatchId")
		.custom((value) => isValidObjectId(value))
		.withMessage("Invalid mismatch id."),
	text("note", "Explain the mismatch", 3, 1000),
	rejectIfInvalid,
];

export const validateUpdateSetting = [
	param("key")
		.isString()
		.matches(/^[a-zA-Z]+\.[a-zA-Z]+$/)
		.withMessage("Unknown setting."),
	body("value").exists().withMessage("Give the new value."),
	text("reason", "Say why you are changing it", 3, 1000),
	body("expectedVersion").optional().isInt({ min: 0 }).withMessage("expectedVersion must be a whole number."),
	rejectIfInvalid,
];

export const validateOpenCase = [
	body("category")
		.isIn(CASE_CATEGORIES)
		.withMessage(`category must be one of: ${CASE_CATEGORIES.join(", ")}.`),
	text("subject", "Give the case a subject", 3, 200),
	text("description", "Describe the case", 3, 5000),
	body("priority")
		.optional()
		.isIn(CASE_PRIORITIES)
		.withMessage(`priority must be one of: ${CASE_PRIORITIES.join(", ")}.`),
	optionalId("bookingId", "booking"),
	optionalId("paymentId", "payment"),
	optionalId("userId", "user"),
	optionalId("assigneeId", "admin"),
	rejectIfInvalid,
];

export const validateUpdateCase = [
	body("status")
		.optional()
		.isIn(CASE_STATUSES)
		.withMessage(`status must be one of: ${CASE_STATUSES.join(", ")}.`),
	body("priority")
		.optional()
		.isIn(CASE_PRIORITIES)
		.withMessage(`priority must be one of: ${CASE_PRIORITIES.join(", ")}.`),
	body("category")
		.optional()
		.isIn(CASE_CATEGORIES)
		.withMessage(`category must be one of: ${CASE_CATEGORIES.join(", ")}.`),
	optionalId("assigneeId", "admin"),
	body("expectedVersion").optional().isInt({ min: 0 }).withMessage("expectedVersion must be a whole number."),
	optionalReason(),
	rejectIfInvalid,
];

export const validateCaseNote = [text("body", "Write the note", 1, 5000), rejectIfInvalid];

export const validateCaseMessage = [
	body("to").isIn(["customer", "provider"]).withMessage("to must be customer or provider."),
	text("subject", "Write a subject", 3, 150),
	text("body", "Write the message", 1, 5000),
	body("idempotencyKey")
		.isString()
		.matches(IDEMPOTENCY_KEY)
		.withMessage("idempotencyKey must be 8 to 64 letters, digits, - or _ (one per message)."),
	rejectIfInvalid,
];

export const validateCaseAction = [
	body("kind")
		.isIn(CASE_ACTION_TYPES)
		.withMessage(`kind must be one of: ${CASE_ACTION_TYPES.join(", ")}.`),
	body("targetType").isIn(["payment", "booking", "user"]).withMessage("targetType must be payment, booking or user."),
	body("targetId")
		.custom((value) => isValidObjectId(value))
		.withMessage("Invalid targetId."),
	text("summary", "Summarise what was done", 3, 1000),
	rejectIfInvalid,
];

export const validateResolveCase = [
	body("outcome")
		.isIn(CASE_OUTCOMES)
		.withMessage(`outcome must be one of: ${CASE_OUTCOMES.join(", ")}.`),
	text("summary", "Summarise the resolution", 3, 2000),
	rejectIfInvalid,
];

export const validateSendAnnouncement = [
	body("idempotencyKey")
		.isString()
		.matches(IDEMPOTENCY_KEY)
		.withMessage("idempotencyKey must be 8 to 64 letters, digits, - or _ (one per send dialog)."),
	body("confirmReachable")
		.isInt({ min: 1 })
		.withMessage("confirmReachable must be the number of people the preview showed."),
	rejectIfInvalid,
];

export const validateTemplateBody = [
	body("name").isString().withMessage("Name the template."),
	body("title").isString().withMessage("Write the title."),
	body("body").isString().withMessage("Write the message."),
	body("emailSubject").optional({ values: "null" }).isString().withMessage("The email subject must be text."),
	rejectIfInvalid,
];
