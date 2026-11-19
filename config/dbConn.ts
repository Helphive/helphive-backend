import mongoose from "mongoose";
import log from "../lib/logger";

const connectDB = async () => {
	try {
		await mongoose.connect(process.env.DATABASE_URI || "");
	} catch (err) {
		log.critical("Could not connect to MongoDB", err);
	}
};

export default connectDB;
