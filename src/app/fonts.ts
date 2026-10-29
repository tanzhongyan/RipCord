import { Geist, Geist_Mono } from "next/font/google";

const geist = Geist({
  subsets: ["latin"],
  variable: "--font-geist-sans",
});

const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
});

/** Classes that define the Geist font variables; the root layout and Storybook apply them. */
export const fontVariables = `${geist.variable} ${geistMono.variable}`;
