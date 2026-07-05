/** @type {import('next').NextConfig} */
const API_ORIGIN = process.env.ORIN_API_ORIGIN ?? "https://orin-bot.duckdns.org";

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
};

export default nextConfig;
