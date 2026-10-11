import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "CitrusGuard - Citrus Disease Detection with Explainable AI",
    template: "%s | CitrusGuard",
  },
  description:
    "Analyze citrus fruit and leaf images using deep learning, and understand the visual regions that influenced the prediction.",
  keywords: [
    "citrus disease detection",
    "plant disease classification",
    "explainable AI",
    "Grad-CAM",
    "citrus leaf",
    "citrus fruit",
  ],
  authors: [{ name: "CitrusGuard" }],
  openGraph: {
    title: "CitrusGuard - Citrus Disease Detection with Explainable AI",
    description:
      "Analyze citrus fruit and leaf images using deep learning, and understand the visual regions that influenced the prediction.",
    type: "website",
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: "#f8fafc",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-dvh bg-ink-50 text-ink-800 antialiased">
        {/* Skip link: first tab stop on every page. */}
        <a
          href="#main-content"
          className="sr-only rounded-md bg-brand-700 px-4 py-2 text-sm font-medium text-white focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-100"
        >
          Skip to main content
        </a>
        {children}
      </body>
    </html>
  );
}
