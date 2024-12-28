import { Request, Response } from "express";
import BookingModel from "../../dal/models/booking.model";
import EarningModel from "../../dal/models/earning.model";
import UserModel from "../../dal/models/user.model";

export const handleGoogleCloudTasksEarningComplete = async (req: Request, res: Response) => {
	try {
		const { bookingId } = req.body;

		const booking = await BookingModel.findById(bookingId);
		if (!booking) {
			return res.status(200).json({ message: "Booking not found" });
		}

		const provider = await UserModel.findById(booking.providerId);
		if (!provider) {
			return res.status(200).json({ message: "Provider not found" });
		}

		const earning = await EarningModel.findOne({ bookingId: bookingId });
		if (!earning) {
			return res.status(200).json({ message: "Earning not found" });
		}

		if (earning.status === "cancelled") {
			return res.status(200).json({ message: "Earning already cancelled" });
		}

		if (earning.status === "completed") {
			return res.status(200).json({ message: "Earning already paid" });
		}

		earning.status = "completed";
		earning.completionDate = new Date();
		await earning.save();

		provider.availableBalance += earning.amount;
		await provider.save();

		return res.status(200).json({ message: "Payment processed successfully" });
	} catch (error: any) {
		console.log("Error updating earning status: ", error);
		return res.status(500).json({ message: "Internal server error" });
	}
};
