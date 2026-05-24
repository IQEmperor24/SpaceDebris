"use client";

import dynamic from "next/dynamic";

/* ============================================================
   SpaceDebris — Main Dashboard (3 panels + fleet intelligence)

   All panels are dynamically imported with ssr: false:
   - They render Three.js / browser-only APIs (Panel 1 especially).
   - In the Next.js 14 App Router, `next/dynamic` with
     { ssr: false } is only allowed inside a Client Component,
     which is why this file is "use client".

   NOTE: metadata is intentionally NOT exported here — that only
   works in Server Components. Title/description live in
   app/layout.tsx.

   Session 4 — Fleet Intelligence (Phase 3) sits BELOW the
   existing 3-panel grid as a full-width section. The grid keeps
   its fixed `lg:h-[calc(100vh-7rem)]` viewport sizing — the
   new section pushes below the fold and is reached by scroll.
   ============================================================ */

const OrbitalMap = dynamic(() => import("@/components/OrbitalMap"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center text-text-secondary font-mono text-sm">
      Initializing orbital map…
    </div>
  ),
});

const RiskScorer = dynamic(() => import("@/components/RiskScorer"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center text-text-secondary font-mono text-sm">
      Loading risk scorer…
    </div>
  ),
});

const AlertFeed = dynamic(() => import("@/components/AlertFeed"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center text-text-secondary font-mono text-sm">
      Connecting to alert feed…
    </div>
  ),
});

const FleetDashboard = dynamic(() => import("@/components/FleetDashboard"), {
  ssr: false,
  loading: () => (
    <div className="glass-card p-4 text-text-secondary font-mono text-sm">
      Loading fleet intelligence…
    </div>
  ),
});

export default function DashboardPage() {
  return (
    <main className="scanlines min-h-screen w-full bg-space px-4 py-4 md:px-6 md:py-6">
      {/* ---------- Header ---------- */}
      <header className="mb-4 flex flex-col gap-1 md:mb-6">
        <div className="flex items-baseline gap-3">
          <h1 className="font-display text-2xl font-extrabold tracking-tight text-text-primary md:text-3xl">
            SPACE<span className="text-safe">DEBRIS</span>
          </h1>
          <span className="font-mono text-xs text-safe blink-cursor">
            LIVE
          </span>
        </div>
        <p className="font-mono text-xs text-text-secondary md:text-sm">
          AI-powered real-time orbital collision risk dashboard · live
          Space-Track.org data
        </p>
      </header>

      {/* ---------- Panel grid ----------
          Large screens: 3 columns × 2 rows.
            - Panel 1 (OrbitalMap): spans 2 cols × 2 rows (the hero).
            - Panel 2 (RiskScorer): top-right.
            - Panel 3 (AlertFeed): bottom-right.
          Small screens: single column, stacked. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3 lg:grid-rows-2 lg:gap-6 lg:h-[calc(100vh-7rem)]">
        {/* Panel 1 — Live 3D Orbital Map */}
        <section className="glass-card relative overflow-hidden lg:col-span-2 lg:row-span-2 min-h-[360px]">
          <PanelHeading>3D ORBITAL MAP</PanelHeading>
          <div className="absolute inset-0 top-9">
            <OrbitalMap />
          </div>
        </section>

        {/* Panel 2 — AI Risk Scorer */}
        <section className="glass-card relative overflow-hidden lg:col-span-1 lg:row-span-1 min-h-[320px]">
          <PanelHeading>AI RISK SCORER</PanelHeading>
          <div className="h-[calc(100%-2.25rem)] overflow-y-auto">
            <RiskScorer />
          </div>
        </section>

        {/* Panel 3 — Collision Alert Feed */}
        <section className="glass-card relative overflow-hidden lg:col-span-1 lg:row-span-1 min-h-[320px]">
          <PanelHeading>COLLISION ALERT FEED</PanelHeading>
          <div className="h-[calc(100%-2.25rem)] overflow-y-auto">
            <AlertFeed />
          </div>
        </section>
      </div>

      {/* ---------- Panel 4 — Fleet Intelligence (full width, below fold) ---------- */}
      <div className="mt-4 md:mt-6">
        <FleetDashboard />
      </div>
    </main>
  );
}

/* Small shared heading bar for each glass panel. */
function PanelHeading({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-9 items-center border-b border-glass px-3">
      <h2 className="font-mono text-[0.7rem] font-semibold uppercase tracking-widest text-text-secondary">
        {children}
      </h2>
    </div>
  );
}
