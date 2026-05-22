import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SpaceDebris — AI Collision Risk Dashboard",
  description:
    "Real-time AI-powered space debris collision risk dashboard. Scores orbital threats and recommends avoidance maneuvers using live Space-Track.org data.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        {/* Google Fonts: Syne (display) + Syne Mono (mono).
            Loaded by literal name so tailwind.config.js and
            globals.css resolve "Syne" / "Syne Mono" directly. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Syne:wght@400;500;600;700;800&family=Syne+Mono&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="bg-space text-text-primary font-display antialiased">
        {children}
      </body>
    </html>
  );
}
