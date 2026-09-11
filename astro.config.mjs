import { defineConfig } from "astro/config";

export default defineConfig({
  output: "static",
  devToolbar: { enabled: false },
  vite: { server: { proxy: { "/api": "http://127.0.0.1:3000" } } }
});
