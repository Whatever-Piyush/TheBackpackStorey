import type { ChannelProvider } from "../provider.ts";
import { ManualProvider } from "./manual.ts";
import { MockProvider } from "./mock.ts";

/**
 * Every provider the system can use.
 *
 * Deliberately free of any database or framework import, so the shared contract
 * suite can load it under plain Node. A provider that needed the PMS to be
 * constructed could not be swapped, which is the whole point of the interface.
 *
 * Adding STAAH is one import and one entry.
 */
export const PROVIDERS: Record<string, ChannelProvider> = {
  manual: new ManualProvider(),
  // The mock exists to exercise the pipeline before a contract is signed, so it
  // is not registered in production: an unroutable provider cannot be selected by
  // configuration, cannot be reached by a webhook, and cannot be left enabled by
  // accident. Its verify() also fails closed — this is the second lock, not the
  // only one.
  ...(process.env.NODE_ENV === "production" ? {} : { mock: new MockProvider() }),
  // staah: new StaahProvider(),
  // siteminder: new SiteMinderProvider(),
};

export function getProvider(id: string): ChannelProvider | null {
  return PROVIDERS[id] ?? null;
}

export function listProviders(): ChannelProvider[] {
  return Object.values(PROVIDERS);
}
