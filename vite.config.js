import { defineConfig } from "vite";

export default defineConfig({
  plugins: [],
  test: {
    environment: "node",
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          firebase: ["firebase/app", "firebase/database", "firebase/auth"],
        },
      },
    },
  },
  server: {
    open: true,
  },
});