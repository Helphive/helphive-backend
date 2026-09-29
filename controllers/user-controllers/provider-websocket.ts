import { WebSocket as WS } from "ws";
import UserModel from "../../dal/models/user.model";

interface AvailabilityMessage {
	isProviderAvailable?: boolean;
	currentLocation?: {
		latitude: number;
		longitude: number;
	};
	selectedJobs?: number[];
}

// Latest socket per provider. A reconnect (e.g. on location change) opens a new socket before the old one's
// close event fires, so only the latest socket may mark the provider offline.
const activeSockets = new Map<string, WS>();

export const handleProviderAvailabilityWebSocket = (ws: WS, userEmail: string) => {
	activeSockets.set(userEmail, ws);

	ws.on("message", async (message: Buffer) => {
		const messageString = message.toString();
		try {
			const user = await UserModel.findOne({ email: userEmail });
			if (!user) {
				ws.send(JSON.stringify({ error: "User not found." }));
				ws.close();
				return;
			}

			const data: AvailabilityMessage = JSON.parse(messageString);
			if (data.isProviderAvailable !== undefined) {
				user.isProviderAvailable = data.isProviderAvailable;
				user.currentLocation = data.currentLocation || user.currentLocation;
				if (data.selectedJobs) {
					user.selectedJobTypes = data.selectedJobs.map((id: number) => ({ id }));
				}
				try {
					await user.save();
					console.log("User data saved successfully.");
					ws.send(JSON.stringify({ message: "Provider availability updated." }));
				} catch (error) {
					console.error("Error saving user data:", error);
					ws.send(JSON.stringify({ error: "An error occurred while saving user data." }));
				}
			} else {
				console.log("No availability data found in message.");
			}
		} catch (error) {
			console.error("Error processing message:", error);
			ws.send(JSON.stringify({ error: "An error occurred while processing the message." }));
		}
	});

	ws.on("close", async () => {
		if (activeSockets.get(userEmail) !== ws) return;
		activeSockets.delete(userEmail);
		try {
			await UserModel.updateOne({ email: userEmail }, { $set: { isProviderAvailable: false } }).exec();
			console.log("Connection closed, provider availability set to false.");
		} catch (error) {
			console.error("Error updating provider availability on disconnect:", error);
		}
	});
};
