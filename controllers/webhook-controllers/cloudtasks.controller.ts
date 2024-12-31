import { Request, Response } from "express";
import BookingModel from "../../dal/models/booking.model";
import EarningModel from "../../dal/models/earning.model";
import UserModel from "../../dal/models/user.model";
import stripe from "../service-accounts/stripe";

import { sendNotification } from "../service-accounts/onesignal";

export const handleGoogleCloudTasksEarningComplete = async (req: Request, res: Response) => {
	try {
		const { bookingId } = req.body;

		if (!bookingId) {
			return res.status(400).json({ message: "Booking ID is required" });
		}

		const booking = await BookingModel.findById(bookingId);
		if (!booking) {
			return res.status(404).json({ message: "Booking not found" });
		}

		const provider = await UserModel.findById(booking.providerId);
		if (!provider || !provider.stripeConnectedAccountId) {
			return res.status(404).json({ message: "Provider not found or missing Stripe connected account" });
		}

		const earning = await EarningModel.findOne({ bookingId });
		if (!earning) {
			return res.status(404).json({ message: "Earning record not found" });
		}

		if (earning.status === "cancelled") {
			return res.status(400).json({ message: "Earning already cancelled" });
		}

		if (earning.status === "completed") {
			return res.status(400).json({ message: "Earning already processed" });
		}

		console.log(`Retrieving Stripe account: ${provider.stripeConnectedAccountId}`);
		const account = await stripe.accounts.retrieve(provider.stripeConnectedAccountId);

		if (account.details_submitted === false) {
			return res.status(400).json({ message: "Provider has not completed Stripe onboarding" });
		}

		const amountInCents = Math.round(earning.amount * 100);
		const platformBalance = await stripe.balance.retrieve();
		const availablePlatformBalance = platformBalance.available.find((balance) => balance.currency === "usd");

		if (!availablePlatformBalance || availablePlatformBalance.amount < amountInCents) {
			return res.status(400).json({ message: "Insufficient platform balance for payout" });
		}

		const transfer = await stripe.transfers.create({
			amount: amountInCents,
			currency: "usd",
			destination: provider.stripeConnectedAccountId,
		});

		earning.status = "completed";
		earning.completionDate = new Date();
		earning.transferId = transfer.id;
		await earning.save();

		provider.availableBalance += earning.amount;
		await provider.save();

		await sendPaymentNotification(provider._id as string, earning.amount);

		return res.status(200).json({
			message: "Payment processed successfully",
			transferId: transfer.id,
		});
	} catch (error: any) {
		console.error("Error processing earning payout: ", error);

		if (error.type === "StripeCardError") {
			return res.status(400).json({ message: error.message });
		}

		return res.status(500).json({ message: "Internal server error" });
	}
};

const sendPaymentNotification = async (providerId: string, amount: number) => {
	try {
		const notificationMessage = {
			include_aliases: { external_id: [providerId] },
			contents: { en: `Your latest funds were released in your account 🎉` },
			headings: { en: `$${amount} received in your account!` },
			data: {
				screen: "Earnings",
			},
		};
		sendNotification(notificationMessage);
	} catch (error) {
		console.error(`Error sending payment notification for earning ID: `, error);
	}
};
