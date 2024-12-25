import tseslint from "typescript-eslint";
import { includeIgnoreFile } from "@eslint/compat";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const eslintIgnorePath = path.resolve(__dirname, ".eslintignore");

export default [
	includeIgnoreFile(eslintIgnorePath),
	...tseslint.configs.recommended,
	{
		ignores: ["logs/**/*", "dist/**/*", "eslint.config.mjs"],
		plugins: {
			"@typescript-eslint": tseslint.plugin,
		},
		languageOptions: {
			parser: tseslint.parser,
			parserOptions: {
				project: true,
			},
		},
		rules: {
			"@typescript-eslint/no-explicit-any": 0,
		},
	},
	{
		files: ["**/*.[js,jsx]"],
		...tseslint.configs.disableTypeChecked,
		ignores: ["logs/**/*", "dist/**/*", "eslint.config.mjs"],
	},
];
