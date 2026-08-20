import type { Metadata } from "next";
import { SITE } from "@/lib/site";
import { ElevationTag } from "@/components/elevation-tag";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Cancellation Policy",
  description:
    "How deposits and cancellations work at Backpackers Storey, Bir — a 20% deposit online, the rest paid at the property.",
};

// The published wording lives in the database (cancellation_policies.body_text) so it
// can be versioned without a redeploy; render it fresh rather than caching a copy.
export const dynamic = "force-dynamic";

type PublishedPolicy = {
  version: number;
  body: string;
  cutoffHours: number;
  refundPercent: number;
};

async function getPublishedPolicy(): Promise<PublishedPolicy | null> {
  if (!isSupabaseConfigured) return null;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("public_cancellation_policy");
  if (error || !data) return null;
  return data as PublishedPolicy;
}

export default async function CancellationPolicyPage() {
  const policy = await getPublishedPolicy();

  return (
    <section className="mx-auto max-w-3xl px-5 py-20 sm:px-8 sm:py-24">
      <ElevationTag label="Before you book" elevation={SITE.elevation.property} />
      <h1 className="mt-5 font-display text-4xl font-extrabold leading-tight tracking-tight text-paper sm:text-5xl">
        Cancellation policy
      </h1>

      {policy ? (
        <div className="mt-8 space-y-5">
          {policy.body.split("\n\n").map((para) => (
            <p key={para} className="text-base leading-relaxed text-sage">
              {para}
            </p>
          ))}
        </div>
      ) : (
        <p className="mt-8 text-base leading-relaxed text-sage">
          Our cancellation policy is temporarily unavailable. Please contact us and
          we&apos;ll confirm the terms before you book.
        </p>
      )}
    </section>
  );
}
