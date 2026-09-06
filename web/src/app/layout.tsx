import type { Metadata, Viewport } from "next";
import { inter, instrumentSerif, instrumentSerifItalic } from "@/lib/fonts";
import { AppShell } from "@/components/app-shell";
import "./globals.css";

export const metadata: Metadata = {
  title: "career-ops — official web experience",
  description: "The official, local-first web experience for career-ops.",
  // Home-screen / standalone (iOS): let our theme-color flow up to the status bar
  // + Dynamic Island; safe-area insets handle the layout.
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "career-ops" },
};

export const viewport: Viewport = {
  // viewport-fit=cover → env(safe-area-inset-*) become non-zero so the header can
  // sit flush under the notch / Dynamic Island.
  viewportFit: "cover",
  // Default (corrected to the real theme before paint by THEME_SCRIPT, then kept
  // in sync by the theme toggle). Dark flows seamlessly into the black island.
  // DARK IS THE DEFAULT (user request 2026-09-07): only an explicit 'light' in
  // localStorage renders the light theme; system preference is ignored.
  themeColor: "#0a0a0a",
};

// DARK IS SERVER-RENDERED: the <html> tag ships class="dark" from the JSX, so
// the default theme cannot be lost to caching, script timing, or hydration
// patching (an inline pre-paint classList.add was observed being wiped on this
// setup, 2026-09-07). This script only handles the OPPOSITE case — a stored
// explicit 'light' choice — before paint; ThemeToggle re-enforces the stored
// preference after hydration as the final authority.
const THEME_SCRIPT = `(function(){try{if(localStorage.getItem('career-ops:theme')==='light'){document.documentElement.classList.remove('dark');var m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute('content','#f7f6f3');}}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`dark ${inter.variable} ${instrumentSerif.variable} ${instrumentSerifItalic.variable}`}
    >
      <head>
        {/* The app ships its own light/dark theme (ThemeToggle + THEME_SCRIPT).
            Dark Reader honors this lock and leaves the DOM alone — without it,
            the extension injects data-darkreader-* attributes into every SVG
            before React hydrates, causing hydration-mismatch errors. */}
        <meta name="darkreader-lock" />
      </head>
      <body className="font-sans antialiased">
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
