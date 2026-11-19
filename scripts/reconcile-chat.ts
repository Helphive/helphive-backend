// Brings CometChat in line with bookings: every customer-provider pair that may chat now (a shared booking from
// acceptance until CHAT_GRACE_DAYS after it ended; the demo accounts only with each other) is a CometChat friendship,
// and no other pair is.
// Also records each pair in `chatlinks` and gives chat-suspended people the suspended CometChat role.
//
//   npx ts-node scripts/reconcile-chat.ts                     dry run: what would change (counts only)
//   npx ts-node scripts/reconcile-chat.ts --apply             make the changes
//   npx ts-node scripts/reconcile-chat.ts --apply --schedule  also schedule the Cloud Task that closes each open
//                                                              grace period (needs the Cloud Tasks credentials)
//
// Safe to re-run. Needs DATABASE_URI and the COMETCHAT_* variables. Prints counts, never names or emails.
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

import BookingModel from "../dal/models/booking.model";
import UserModel from "../dal/models/user.model";
import { ChatLinkModel } from "../dal/models/chat.model";
import { CHAT_SUSPENDED_ROLE, chatConfig } from "../config/chat";
import { DEMO_ACCOUNT_EMAILS } from "../config/demoAccounts";
import { cometChat } from "../lib/chat/cometchat";
import { decidePair } from "../lib/chat/chatRules";
import { syncChatPair } from "../lib/chat/chatSync";

const pairKey = (customerId: unknown, providerId: unknown) => `${String(customerId)}|${String(providerId)}`;

const main = async () => {
	const apply = process.argv.includes("--apply");
	const schedule = process.argv.includes("--schedule");
	if (!process.env.DATABASE_URI) throw new Error("DATABASE_URI is not set.");
	const config = chatConfig();
	if (!config.configured) {
		console.log("Chat is not configured (COMETCHAT_APP_ID, COMETCHAT_REGION, COMETCHAT_REST_API_KEY).");
		console.log("The plan below is from the database only; CometChat cannot be compared or changed.");
	}
	mongoose.set("autoIndex", false);
	await mongoose.connect(process.env.DATABASE_URI);
	const now = new Date();

	// Every pair that ever shared a booking with a provider on it.
	const pairs = await BookingModel.aggregate<{ _id: { customerId: unknown; providerId: unknown } }>([
		{ $match: { providerId: { $ne: null } } },
		{ $group: { _id: { customerId: "$userId", providerId: "$providerId" } } },
	]);
	const demoUsers = await UserModel.find({ email: { $in: [...DEMO_ACCOUNT_EMAILS] } })
		.select("_id")
		.lean()
		.exec();
	const demoIds = new Set(demoUsers.map((u) => String(u._id)));

	const desired = new Map<string, boolean>();
	for (const { _id } of pairs) {
		const bookings = await BookingModel.find({ userId: _id.customerId, providerId: _id.providerId })
			.select("status userId providerId completedAt cancelledAt updatedAt")
			.lean()
			.exec();
		const state = decidePair(
			bookings as any[],
			{
				customerIsDemo: demoIds.has(String(_id.customerId)),
				providerIsDemo: demoIds.has(String(_id.providerId)),
			},
			now,
			config.graceMs,
		);
		desired.set(pairKey(_id.customerId, _id.providerId), state.allowed);
	}

	// What CometChat has today: each customer's friends.
	const actualFriends = new Map<string, Set<string>>();
	let unreadableCustomers = 0;
	if (config.configured) {
		const customers = new Set(pairs.map((p) => String(p._id.customerId)));
		for (const customerId of customers) {
			try {
				actualFriends.set(customerId, new Set(await cometChat.listFriends(customerId)));
			} catch {
				unreadableCustomers++;
			}
		}
	}

	const links = new Map(
		(await ChatLinkModel.find({}).select("customerId providerId allowed").lean().exec()).map((l) => [
			pairKey(l.customerId, l.providerId),
			l.allowed,
		]),
	);

	let toOpen = 0;
	let toClose = 0;
	let linkOnly = 0;
	let unchanged = 0;
	const work: [string, string][] = [];
	for (const [key, allowed] of desired) {
		const [customerId, providerId] = key.split("|");
		const friends = actualFriends.get(customerId);
		const inCometChat = friends ? friends.has(providerId) : null;
		const recorded = links.get(key);
		if (inCometChat !== null && inCometChat !== allowed) {
			if (allowed) toOpen++;
			else toClose++;
			work.push([customerId, providerId]);
		} else if (recorded !== allowed || (inCometChat === null && config.configured)) {
			linkOnly++;
			work.push([customerId, providerId]);
		} else {
			unchanged++;
		}
	}

	// Friendships in CometChat with no booking behind them at all (made by hand or by an old flow).
	let strayFriendships = 0;
	const strays: [string, string][] = [];
	for (const [customerId, friends] of actualFriends) {
		for (const friendId of friends) {
			if (!desired.has(pairKey(customerId, friendId))) {
				strayFriendships++;
				strays.push([customerId, friendId]);
			}
		}
	}

	const chatSuspended = await UserModel.find({ chatSuspended: true }).select("_id").lean().exec();

	console.log(`Pairs that shared an accepted booking: ${pairs.length}`);
	console.log(`  may chat now: ${[...desired.values()].filter(Boolean).length}`);
	console.log(`  to open in CometChat: ${toOpen}`);
	console.log(`  to close in CometChat: ${toClose}`);
	console.log(`  record only (chatlinks): ${linkOnly}`);
	console.log(`  already right: ${unchanged}`);
	console.log(`Friendships with no booking behind them, to remove: ${strayFriendships}`);
	console.log(`Customers whose CometChat friends could not be read: ${unreadableCustomers}`);
	console.log(`Chat-suspended people (role ${CHAT_SUSPENDED_ROLE}): ${chatSuspended.length}`);
	console.log(`Demo accounts found: ${demoIds.size} (they may chat with each other only, per bookings)`);

	if (!apply) {
		console.log("Dry run: run again with --apply to make these changes.");
	} else if (!config.configured) {
		console.log("Not applied: chat is not configured.");
	} else {
		let failed = 0;
		for (const [customerId, providerId] of work) {
			const result = await syncChatPair(customerId, providerId, { now, scheduleCheck: schedule });
			if (!result?.synced) failed++;
		}
		for (const [customerId, friendId] of strays) {
			await cometChat.removeFriend(customerId, friendId).catch(() => failed++);
		}
		for (const user of chatSuspended) {
			await cometChat.updateUser(String(user._id), { role: CHAT_SUSPENDED_ROLE }).catch(() => failed++);
		}
		console.log(`Applied. ${failed} change(s) failed; re-run to retry them.`);
	}
	await mongoose.disconnect();
};

main().catch(async (error) => {
	console.error(error instanceof Error ? error.message : error);
	await mongoose.disconnect().catch(() => undefined);
	process.exit(1);
});
