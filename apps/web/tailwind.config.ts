import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        panel: "#0f1115",
        border: "#1f232b",
        accent: "#3ddc97",
      },
    },
  },
  plugins: [],
};
export default config;
