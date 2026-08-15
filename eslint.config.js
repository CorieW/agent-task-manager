/** Defines the repository's TypeScript lint rules and generated-file exclusions. */
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["coverage/**", "dist/**", "node_modules/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      // Cleanup deliberately aggregates and can supersede a primary failure.
      "no-unsafe-finally": "off",
      // AggregateError retains both failures even when its primary cause differs from the caught cleanup error.
      "preserve-caught-error": "off",
    },
  },
);
