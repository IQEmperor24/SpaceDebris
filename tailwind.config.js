/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // Space theme — see Design System in CONTEXT.md
        space: "#000008",      // deep space black background
        safe: "#00FF41",       // matrix green — stable / safe
        caution: "#FFB800",    // amber — warning
        danger: "#FF3131",     // red — critical
        "text-primary": "#E0E0E0",
        "text-secondary": "#888888",
        "text-muted": "#444444",
      },
      backgroundColor: {
        glass: "rgba(255,255,255,0.04)",
      },
      borderColor: {
        glass: "rgba(255,255,255,0.08)",
      },
      fontFamily: {
        display: ["Syne", "sans-serif"],
        mono: ["'Syne Mono'", "monospace"],
      },
    },
  },
  plugins: [],
};
