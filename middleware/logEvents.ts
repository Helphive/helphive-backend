import path from "path";
import fs, { promises as fsPromises } from "fs";
import { v4 as uuid } from "uuid";
import { format } from "date-fns";
import { Request, Response, NextFunction } from "express";

export const logEvents = async (message: string, logName: string) => {
	const dateTime = `${format(new Date(), "yyyyMMdd\tHH:mm:ss")}`;
	const logItem = `${dateTime}\t${uuid()}\t${message}\n`;

	try {
		if (!fs.existsSync(path.join(__dirname, "..", "logs"))) {
			await fsPromises.mkdir(path.join(__dirname, "..", "logs"));
		}

		await fsPromises.appendFile(path.join(__dirname, "..", "logs", logName), logItem);
	} catch (err) {
		console.log(err);
	}
};

export const logger = (req: Request, res: Response, next: NextFunction) => {
	logEvents(`${req.method}\t${req.headers.origin}\t${req.url}`, "reqLog.txt");
	console.log(`${req.method} ${req.path}`);
	next();
};
