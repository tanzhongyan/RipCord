import { Geist, Geist_Mono } from "next/font/google";

const geist = Geist({
  subsets: ["latin"],
  variable: "--font-geist-sans",
});

// Mono sets amounts and codes, never the first paint; preloading it slows LCP on phones.
const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
  preload: false,
});

/** Classes that define the Geist font variables; the root layout and Storybook apply them. */
export const fontVariables = `${geist.variable} ${geistMono.variable}`;
