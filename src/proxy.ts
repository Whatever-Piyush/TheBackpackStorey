import { NextResponse, type NextRequest } from "next/server";
import { STAFF_PORTAL_ENABLED } from "@/lib/launch-server";
import { updateSession } from "@/lib/supabase/proxy-session";

/** The staff-only surface. Absent on the public portfolio deployment. */
const STAFF_PREFIXES = ["/login", "/pos", "/stays", "/reception", "/api/channel"];

function isStaffPath(path: string): boolean {
  return STAFF_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

// Next 16: this file was formerly `middleware.ts`. Same job, new name.
export async function proxy(request: NextRequest) {
  if (!STAFF_PORTAL_ENABLED) {
    const path = request.nextUrl.pathname;
    if (isStaffPath(path)) {
      // Answer here, before any page or route code (and any Supabase client)
      // runs: machine endpoints get a bare 404; pages get the site's own
      // not-found page via a rewrite to a path that matches nothing.
      if (path.startsWith("/api/")) return new NextResponse(null, { status: 404 });
      return NextResponse.rewrite(new URL("/__staff-portal-off", request.url));
    }
    // Portfolio deployment: nothing to refresh, nothing to redirect.
    return NextResponse.next();
  }
  return updateSession(request);
}

export const config = {
  // Run on everything except Next internals, static assets, and the property photos.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|photos/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
