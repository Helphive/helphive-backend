// Request validation for the risk routes. Each chain ends with rejectIfInvalid (400 { message }).
import { body, param } from "express-validator";
import { isValidObjectId } from "../user-controllers/utils/booking.utils";
import { rejectIfInvalid } from "../user-controllers/validators/common.validators";
import { LIST_KINDS, LIST_TYPES } from "../../lib/risk/lists";
import { CASE_SUBJECT_TYPES, HOLD_KINDS } from "../../dal/models/risk.model";

const reason = () =>
	body("reason")
		.isString()
		.withMessage("Give a reason (3 to 1000 characters).")
		.trim()
		.isLength({ min: 3, max: 1000 })
		.withMessage("Give a reason (3 to 1000 characters).");

const objectId = (field: string, label: string) =>
	body(field)
		.custom((value) => isValidObjectId(value))
		.withMessage(`Invalid ${label} id.`);

/** ISO time in the future, or null to never expire. */
const expiresAt = () =>
	body("expiresAt")
		.optional({ values: "undefined" })
		.custom((value) => value === null || (typeof value === "string" && Date.parse(value) > Date.now()))
		.withMessage("expiresAt must be a future ISO time, or null for no expiry.");

export const riskIdParam = (label: string) => [
	param("id")
		.custom((value) => isValidObjectId(value))
		.withMessage(`Invalid ${label} id.`),
	rejectIfInvalid,
];

export const validateRiskReason = [reason(), rejectIfInvalid];

export const validateOpenCase = [
	body("subjectType")
		.isIn(CASE_SUBJECT_TYPES)
		.withMessage(`subjectType must be one of: ${CASE_SUBJECT_TYPES.join(", ")}.`),
	objectId("subjectId", "subject"),
	reason(),
	rejectIfInvalid,
];

export const validateAssign = [
	body("assignee")
		.custom((value) => value === null || value === "me" || isValidObjectId(value))
		.withMessage('assignee must be "me", an admin id, or null to unassign.'),
	rejectIfInvalid,
];

export const validateCaseStatus = [
	body("status").isIn(["open", "in_review"]).withMessage("status must be open or in_review (decide to close)."),
	rejectIfInvalid,
];

export const validateCaseNote = [
	body("body")
		.isString()
		.trim()
		.isLength({ min: 1, max: 2000 })
		.withMessage("Write the note (1 to 2000 characters)."),
	rejectIfInvalid,
];

export const validateDecision = [
	body("outcome").isIn(["cleared", "confirmed"]).withMessage("outcome must be cleared or confirmed."),
	reason(),
	rejectIfInvalid,
];

export const validateHold = [
	body("kind")
		.isIn(HOLD_KINDS)
		.withMessage(`kind must be one of: ${HOLD_KINDS.join(", ")}.`),
	reason(),
	rejectIfInvalid,
];

export const validatePlaceHold = [objectId("userId", "user"), ...validateHold];

export const validateCaseRefund = [objectId("paymentId", "payment"), rejectIfInvalid];

export const validateListEntry = [
	body("list").isIn(LIST_TYPES).withMessage("list must be block or allow."),
	body("kind")
		.isIn(LIST_KINDS)
		.withMessage(`kind must be one of: ${LIST_KINDS.join(", ")}.`),
	body("value").isString().isLength({ min: 1, max: 320 }).withMessage("value is required."),
	expiresAt(),
	reason(),
	rejectIfInvalid,
];

/** From a case: list is always block. */
export const validateCaseBlock = [
	body("kind")
		.isIn(LIST_KINDS)
		.withMessage(`kind must be one of: ${LIST_KINDS.join(", ")}.`),
	body("value").isString().isLength({ min: 1, max: 320 }).withMessage("value is required."),
	expiresAt(),
	reason(),
	rejectIfInvalid,
];

export const validateListExpiry = [
	body("expiresAt")
		.custom((value) => value === null || (typeof value === "string" && Date.parse(value) > Date.now()))
		.withMessage("expiresAt must be a future ISO time, or null for no expiry."),
	reason(),
	rejectIfInvalid,
];
