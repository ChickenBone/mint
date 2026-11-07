const { defineConfig } = require("eslint/config");
const expoConfig = require("eslint-config-expo/flat");
module.exports = defineConfig([
  expoConfig,
  { ignores: [".expo/**", "dist/**", "android/**", "ios/**"] },
  { files: ["*.cjs", "app.config.js"], languageOptions: { globals: { __dirname: "readonly", process: "readonly" } } },
  {
    files: ["app/**/*.{ts,tsx}", "src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: ["@mint/core", "@mint/core/*", "next", "next/*", "node:*"],
      }],
    },
  },
]);
