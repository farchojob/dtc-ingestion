import { NextResponse, type NextRequest } from "next/server";

/** GET /theme?to=dark&back=/northwind/runs — sets the cookie and goes back. A link, not a client toggle. */
export function GET(req: NextRequest): NextResponse {
  const to = req.nextUrl.searchParams.get("to") === "dark" ? "dark" : "light";
  const back = req.nextUrl.searchParams.get("back") ?? "/";
  const res = NextResponse.redirect(new URL(back.startsWith("/") ? back : "/", req.nextUrl.origin));
  res.cookies.set("theme", to, { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax" });
  return res;
}
