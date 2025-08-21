/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: [
    "./public/index.html",
    "./src/**/*.{js,jsx,ts,tsx}"
  ],
  theme: {
    extend: {
      boxShadow: {
        card: "0 10px 24px rgba(0,0,0,0.35), inset 0 0 0 1px rgba(255,255,255,0.02)"
      }
    },
  },
  plugins: [],
};
