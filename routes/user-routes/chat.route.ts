// Chat for signed-in customers and providers, mounted at /auth/chat. Every route: authentication, a rate limit, then
// validation (tests/newRoutes.test.ts checks it). See scratch/chat/chat-contract.md.
import express from "express";
import { verifyJWT } from "../../middleware/verifyJWT";
import { verifyRoles } from "../../middleware/verfiyRoles";
import { chatReadLimiter, chatSessionLimiter, chatWriteLimiter } from "../../middleware/rateLimit";
import {
	handleBlockUser,
	handleBookingConversation,
	handleChatContacts,
	handleChatSession,
	handleChatUnreadCount,
	handleChatViewing,
	handleCreateReport,
	handleEndChatSession,
	handleListBlocks,
	handleUnblockUser,
} from "../../controllers/user-controllers/chat.controller";
import {
	validateBlock,
	validateBookingConversation,
	validateCreateReport,
	validateUnblock,
	validateViewing,
} from "../../controllers/user-controllers/validators/chat.validators";
import { validateNoInput } from "../../controllers/user-controllers/validators/common.validators";

const chatRoute = express.Router();

const signedIn = [verifyJWT, verifyRoles("User", "Provider")];

chatRoute.post("/session", ...signedIn, chatSessionLimiter, validateNoInput, handleChatSession);
chatRoute.post("/session/end", ...signedIn, chatSessionLimiter, validateNoInput, handleEndChatSession);
chatRoute.get(
	"/bookings/:bookingId/conversation",
	...signedIn,
	chatReadLimiter,
	...validateBookingConversation,
	handleBookingConversation,
);
chatRoute.put("/viewing", ...signedIn, chatReadLimiter, ...validateViewing, handleChatViewing);
chatRoute.get("/contacts", ...signedIn, chatReadLimiter, validateNoInput, handleChatContacts);
chatRoute.get("/unread-count", ...signedIn, chatReadLimiter, validateNoInput, handleChatUnreadCount);
chatRoute.post("/reports", ...signedIn, chatWriteLimiter, ...validateCreateReport, handleCreateReport);
chatRoute.get("/blocks", ...signedIn, chatReadLimiter, validateNoInput, handleListBlocks);
chatRoute.post("/blocks", ...signedIn, chatWriteLimiter, ...validateBlock, handleBlockUser);
chatRoute.delete("/blocks/:uid", ...signedIn, chatWriteLimiter, ...validateUnblock, handleUnblockUser);

export default chatRoute;
