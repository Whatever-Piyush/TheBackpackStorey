import { Atmosphere } from "@/components/marketing/atmosphere";
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
      <SiteHeader />
      <main className="flex-1">{children}</main>
      <SiteFooter />
    </>
  );
}
