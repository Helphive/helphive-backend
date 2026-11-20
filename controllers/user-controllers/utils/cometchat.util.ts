// The CometChat calls the existing flows make (sign-up, profile photo; booking events are in lib/chat/sendBookingEvent.ts), on top of lib/chat. All
// settings come from the environment (config/chat.ts); the REST API key that used to be hard-coded here is public in
// git history and must be rotated. While chat is not configured these do nothing. None of them throws.
import UserModel from "../../../dal/models/user.model";
import { CHAT_MEMBER_ROLE } from "../../../config/chat";
import { ChatNotConfiguredError, cometChat } from "../../../lib/chat/cometchat";
import { avatarUrl } from "../../../lib/chat/chatSync";
import log from "../../../lib/logger";

const logFailure = (what: string) => (error: any) => {
	if (error instanceof ChatNotConfiguredError) return;
	log.error(`CometChat: could not ${what}`, { status: error?.status ?? null, code: error?.code ?? "unknown" });
};

/** The person's CometChat user, made at sign-up. Their email is not sent to CometChat (it does not need it). */
export const createCometChatUser = async (userId: string, _email: string, name: string) => {
	if (!cometChat.configured) return;
	try {
		await cometChat.createUser({ uid: userId, name, role: CHAT_MEMBER_ROLE });
		await UserModel.updateOne({ _id: userId }, { $set: { chatUserReadyAt: new Date() } }).exec();
	} catch (error) {
		logFailure("create a user")(error);
	}
};

export const updateCometChatUser = async (userId: string, profile: string) => {
	if (!cometChat.configured) return;
	await cometChat.updateUser(userId, { avatar: avatarUrl(profile) }).catch(logFailure("update a user"));
};
