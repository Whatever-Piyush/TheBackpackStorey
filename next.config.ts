import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Enables React's <ViewTransition>, used for marketing page transitions.
    viewTransition: true,
  },
  // Baseline security headers for the public site. Set here (not in
  // netlify.toml) so they apply uniformly to static, ISR and dynamic responses.
  // No CSP yet: the inline styles, WebGL scene and Maps iframe need a tested
  // policy first. HSTS without preload/includeSubDomains, so it stays reversible.
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Strict-Transport-Security", value: "max-age=31536000" },
        ],
      },
    ];
  },
};

export default nextConfig;
