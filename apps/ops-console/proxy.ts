import { NextResponse, type NextRequest } from "next/server";

/** The layout renders the top bar and needs the path (active tenant, where the theme link returns to). */
export function proxy(req: NextRequest): NextResponse {
  const headers = new Headers(req.headers);
  headers.set("x-pathname", req.nextUrl.pathname + req.nextUrl.search);
  return NextResponse.next({ request: { headers } });
}

export const config = { matcher: ["/((?!_next|favicon.ico|theme).*)"] };
