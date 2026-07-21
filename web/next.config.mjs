/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    unoptimized: true,
  },
  async headers() {
    return [
      { source: "/v1/:path*", headers: [{ key: "Cache-Control", value: "private, no-store, max-age=0" }] },
    ];
  },
};

export default nextConfig;
