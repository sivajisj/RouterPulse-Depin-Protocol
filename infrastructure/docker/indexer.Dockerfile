FROM node:22-alpine

WORKDIR /app

# Dependencies first so a source-only change doesn't re-run npm ci.
COPY indexer/package.json indexer/package-lock.json ./
RUN npm ci

COPY indexer/tsconfig.json ./
COPY indexer/src ./src

# The indexer is a long-running worker with no health endpoint of its
# own; compose relies on mongo/redis health plus its restart policy.
CMD ["npx", "ts-node", "src/index.ts"]
