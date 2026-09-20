import { FlatCompat } from "@eslint/eslintrc"
import js from "@eslint/js"
import { defineConfig, globalIgnores } from "eslint/config"
import prettier from "eslint-config-prettier/flat"

const compat = new FlatCompat({ baseDirectory: import.meta.dirname })

export default defineConfig([
  js.configs.recommended,
  ...compat.extends(
    "eslint-config-next/core-web-vitals",
    "eslint-config-next/typescript",
  ),
  {
    rules: {
      "import/order": [
        "warn",
        {
          groups: [
            ["builtin", "external"],
            "internal",
            ["parent", "index", "sibling"],
          ],
          "newlines-between": "always",
          alphabetize: {
            order: "asc",
          },
        },
      ],
      "@typescript-eslint/no-unused-vars": "warn",
      "@typescript-eslint/no-unused-expressions": "warn",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-var-requires": "off",
    },
  },
  prettier,
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "public/sw.js",
    "supabase/types.gen.ts",
  ]),
])
