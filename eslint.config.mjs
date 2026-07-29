import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
  globalIgnores(["node_modules/**", "public/**", "Bios/**"]),
  {
    files: ["**/*.{js,jsx,mjs}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: {
        atob: "readonly",
        btoa: "readonly",
        cancelAnimationFrame: "readonly",
        document: "readonly",
        ImageData: "readonly",
        localStorage: "readonly",
        requestAnimationFrame: "readonly",
        TextEncoder: "readonly",
        URL: "readonly",
        window: "readonly",
      },
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    // Core ESLint does not mark JSX tag references as variable use without a
    // React-specific plugin; keep the local dependency tree intentionally small.
    files: ["**/*.jsx"],
    rules: {
      "no-unused-vars": "off",
    },
  },
]);
