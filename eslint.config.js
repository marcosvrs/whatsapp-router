import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { defineConfig, globalIgnores } from "eslint/config";
import js from "@eslint/js";
import tseslint from "typescript-eslint";

const tsconfigRootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig(
  globalIgnores(["dist/**", "coverage/**", "node_modules/**", "reports/**", ".stryker-tmp/**"]),
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.js", "vitest.config.ts", "stryker.config.mjs"],
        },
        tsconfigRootDir,
      },
    },
  },
);
