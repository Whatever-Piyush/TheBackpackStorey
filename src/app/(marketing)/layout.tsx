import { ViewTransition } from "react";
import { Atmosphere } from "@/components/marketing/atmosphere";
import { ScrollProgress } from "@/components/motion/scroll-progress";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";

export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      {/* Fixed dusk-sky backdrop (moved off `body` so it no longer repaints on
          scroll). Marketing-only, so the portal/reception stay plain pine. */}
      <Atmosphere />
      {/* Thin scroll-progress bar pinned to the top of the viewport. */}
      <ScrollProgress />
      <SiteHeader />
      {/*
        Page transitions.

        Two things this setup depends on, both easy to get wrong:
        - `update`, not enter/exit. This layout persists across sibling
          navigations, so the wrapper never mounts or unmounts — only its
          content changes, which is what `update` responds to.
        - It wraps <main> rather than {children}. React names a single child
          DOM node; page children can be a fragment of several, leaving nothing
          to attach a view-transition-name to and no animation at all.

        Links tagged with `transitionTypes` (room cards go forward, "All rooms"
        comes back) slide horizontally; everything else — header nav, footer —
        crossfades. Keyframes live in globals.css alongside the other motion,
        and are disabled under prefers-reduced-motion.
      */}
      <ViewTransition
        update={{
          "nav-forward": "nav-forward",
          "nav-back": "nav-back",
          default: "page-fade",
        }}
      >
        <main className="flex-1">{children}</main>
      </ViewTransition>
      <SiteFooter />
    </>
  );
}
