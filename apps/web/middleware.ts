import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken, SESSION_COOKIE } from "@/lib/session";

const PROTECTED_PREFIXES = ["/dashboard", "/devices", "/rewards"];

export async function middleware(req: NextRequest) {
  const isProtected = PROTECTED_PREFIXES.some((p) =>
    req.nextUrl.pathname.startsWith(p)
  );
  if (!isProtected) return NextResponse.next();

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = token ? await verifySessionToken(token) : null;

  if (!session) {
    const loginUrl = new URL("/login", req.url);
    loginUrl.searchParams.set("redirectTo", req.nextUrl.pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*", "/devices/:path*", "/rewards/:path*"],
};
