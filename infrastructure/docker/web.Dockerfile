FROM node:22-alpine AS builder

WORKDIR /app

COPY web/package.json web/package-lock.json ./
RUN npm ci

COPY web/tsconfig.json web/next.config.js ./
COPY web/src ./src

# NEXT_PUBLIC_* is inlined into the client bundle at build time, so the
# API URL has to be known here rather than injected at runtime.
ARG NEXT_PUBLIC_API_URL=http://localhost:3001
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
RUN npm run build

# Runtime stage: ship the build output and production deps only, not the
# full toolchain and source tree.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY web/package.json web/package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/.next ./.next
COPY --from=builder /app/next.config.js ./

EXPOSE 3000
CMD ["npx", "next", "start", "-p", "3000"]
