FROM oven/bun:1.3.14 AS build

WORKDIR /app

COPY . .
RUN bun install --frozen-lockfile

ARG TURNSTILE_PUBLIC_SITE_ID
RUN VITE_TURNSTILE_SITE_KEY="$TURNSTILE_PUBLIC_SITE_ID" bun run build

FROM oven/bun:1.3.14 AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

COPY --from=build --chown=bun:bun /app /app

USER bun
EXPOSE 3000

CMD ["bun", "apps/api/dist/index.js"]
