import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        ivory: {
          50: "#FCFBF9",
          100: "#FAF8F5",
          200: "#F5F2EB",
          300: "#EAE5DB",
          400: "#DCD5C7",
        },
        forest: {
          900: "#0F2019",
          800: "#162E24",
          700: "#1E3D30",
          600: "#2B5342",
          500: "#3B725B",
          100: "#E3ECE8",
        },
        terracotta: {
          600: "#B34A24",
          500: "#C85A32",
          400: "#DF6E44",
          100: "#FAEDE8",
          50: "#FDF5F2",
        },
        charcoal: {
          900: "#1A1816",
          800: "#2B2824",
          700: "#44403A",
          500: "#706B62",
          400: "#9C968B",
        },
      },
      fontFamily: {
        sans: ["Inter", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "sans-serif"],
      },
    },
  },
  plugins: [],
};
export default config;
