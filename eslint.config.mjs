import { defineConfig } from "eslint/config";
import nextPlugin from "@next/eslint-plugin-next";

export default defineConfig([
  {
    ignores: [".open-next/**", ".wrangler/**", "cloudflare-env.d.ts"],
  },
  nextPlugin.configs["core-web-vitals"],
]);
