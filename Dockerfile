FROM oven/bun:alpine AS base
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --production

COPY index.js ./
COPY src/ ./src/

EXPOSE 4097
ENV PORT=4097
ENV NODE_ENV=production

CMD ["bun", "run", "index.js"]
