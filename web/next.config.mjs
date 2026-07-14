/** @type {import('next').NextConfig} */
const API_ORIGIN = process.env.ORIN_API_ORIGIN ?? "https://bot-production-b076.up.railway.app";

const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  // Proxy the Orin API so cookies stay first-party on any hosting origin (dev, Vercel, self-host).
  async rewrites() {
    return [{ source: "/v1/:path*", destination: `${API_ORIGIN}/v1/:path*` }];
  },
  // Defense in depth: never let the CDN cache authenticated API responses (per-user data).
  async headers() {
    return [
      { source: "/v1/:path*", headers: [{ key: "Cache-Control", value: "private, no-store, max-age=0" }] },
    ];
  },
};

export default nextConfig;
