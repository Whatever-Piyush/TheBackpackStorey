import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Enables React's <ViewTransition>, used for marketing page transitions.
    viewTransition: true,
  },
};

export default nextConfig;
