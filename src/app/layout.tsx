import "~/styles/globals.css";

import type { Metadata } from "next";

import { ThemeProvider } from "~/shared/components/theme-provider";
import { site } from "~/shared/config/site";
import { fontVariables } from "./fonts";

export const metadata: Metadata = {
  metadataBase: new URL(site.url),
  title: { default: site.defaultTitle, template: site.titleTemplate },
  description: site.description,
  openGraph: {
    title: site.defaultTitle,
    description: site.description,
    url: site.url,
    siteName: site.name,
    locale: site.locale,
    type: "website",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={fontVariables} suppressHydrationWarning>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
