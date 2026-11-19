import type { NextFunction, Request, Response } from "express";
import multer from "multer";
import path from "path";
import { runWithContext } from "../lib/requestContext";

// Cloud Run caps an HTTP/1 request at 32 MiB, so this is the most a single file can usefully be.
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

const IMAGE_TYPES: Record<string, string> = {
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	webp: "image/webp",
	gif: "image/gif",
	heic: "image/heic",
	heif: "image/heif",
};

const DOCUMENT_TYPES: Record<string, string> = {
	...IMAGE_TYPES,
	pdf: "application/pdf",
	doc: "application/msword",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

const MIME_TO_EXTENSION: Record<string, string> = {
	"image/jpeg": "jpg",
	"image/jpg": "jpg",
	"image/png": "png",
	"image/webp": "webp",
	"image/gif": "gif",
	"image/heic": "heic",
	"image/heif": "heif",
	"application/pdf": "pdf",
	"application/msword": "doc",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
};

export type UploadKind = "image" | "document";

/**
 * The extension and content type a file is stored with, or null when it is not an accepted type. The extension
 * comes from the file name, or from the declared type when the name has none (some phones send no extension);
 * the stored name never uses anything else the client sent.
 */
export const classifyUpload = (
	kind: UploadKind,
	originalName: string,
	mimeType: string,
): { extension: string; contentType: string } | null => {
	const allowed = kind === "image" ? IMAGE_TYPES : DOCUMENT_TYPES;
	const fromName = path
		.extname(originalName || "")
		.slice(1)
		.toLowerCase();
	const extension = allowed[fromName] ? fromName : MIME_TO_EXTENSION[(mimeType || "").toLowerCase()];
	if (!extension || !allowed[extension]) return null;
	return { extension, contentType: allowed[extension] };
};

const kindOfField = (field: string): UploadKind => (field === "profile" ? "image" : "document");

export class UploadRejectedError extends Error {
	status = 400;
}

/**
 * Memory upload of the named fields, one file each, with size, count and type limits. Multer continues from a stream
 * callback, so the request context is re-entered for the handlers after it.
 */
export const uploadFields = (fields: string[]) => {
	const upload = multerFields(fields);
	return (req: Request, res: Response, next: NextFunction) =>
		upload(req, res, (error?: unknown) =>
			req.context ? runWithContext(req.context, () => next(error)) : next(error),
		);
};

const multerFields = (fields: string[]) =>
	multer({
		storage: multer.memoryStorage(),
		limits: { fileSize: MAX_UPLOAD_BYTES, files: fields.length, fields: 30, fieldSize: 64 * 1024, parts: 40 },
		fileFilter: (_req, file, callback) => {
			if (!fields.includes(file.fieldname)) {
				return callback(new UploadRejectedError(`Unexpected file field ${file.fieldname}.`));
			}
			if (!classifyUpload(kindOfField(file.fieldname), file.originalname, file.mimetype)) {
				const expected =
					kindOfField(file.fieldname) === "image" ? "an image" : "an image, PDF or Word document";
				return callback(new UploadRejectedError(`The ${file.fieldname} file must be ${expected}.`));
			}
			callback(null, true);
		},
	}).fields(fields.map((name) => ({ name, maxCount: 1 })));

/** Stored name parts for an accepted file (the file filter already rejected anything else). */
export const storedFileInfo = (field: string, file: Express.Multer.File) =>
	classifyUpload(kindOfField(field), file.originalname, file.mimetype) as { extension: string; contentType: string };
