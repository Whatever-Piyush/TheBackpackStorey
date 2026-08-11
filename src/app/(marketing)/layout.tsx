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
      <main className="flex-1">{children}</main>
      <SiteFooter />
    </>
  );
}
