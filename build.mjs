import fs from "fs-extra";

async function copyFiles() {
	try {
		await fs.copy("views", "dist/views");
		console.log("Views copied successfully!");
		await fs.copy("public", "dist/public");
		console.log("Public files copied successfully!");
	} catch (err) {
		console.error("Error copying files:", err);
	}
}

copyFiles();
