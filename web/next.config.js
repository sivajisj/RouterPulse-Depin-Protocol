/** @type {import('next').NextConfig} */
const nextConfig = {
    reactStrictMode: true,
    // Security headers. CSP is intentionally strict about what can be
    // loaded, but must allow 'unsafe-inline'/'unsafe-eval' for styles and
    // Next's dev-mode runtime; a production build would tighten these
    // with a nonce-based policy.
    async headers() {
        return [
            {
                source: "/:path*",
                headers: [
                    { key: "X-Content-Type-Options", value: "nosniff" },
                    { key: "X-Frame-Options", value: "DENY" },
                    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
                    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
                ],
            },
        ];
    },
};

module.exports = nextConfig;
