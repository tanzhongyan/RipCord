import { NextResponse } from "next/server";

/**
 * The holder review page carries a bearer token in its URL, so it must never
 * be cached and must never leak the URL as a referrer.
 */
export function middleware() {
  const response = NextResponse.next();
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}

export const config = {
  matcher: "/m/:path*",
};
