import tseslint from "typescript-eslint";

export default [
	...tseslint.configs.recommended,
	{
		ignores: ["logs/", "eslint.config.mjs"],
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
	},
];
