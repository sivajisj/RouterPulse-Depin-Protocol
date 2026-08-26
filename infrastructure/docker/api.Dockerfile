FROM node:22-alpine

WORKDIR /app

COPY api/package.json api/package-lock.json ./
RUN npm ci

COPY api/tsconfig.json ./
COPY api/src ./src

EXPOSE 3001
CMD ["npx", "ts-node", "src/main.ts"]
