FROM node:22-bookworm AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3737
ENV APP_DATA_DIR=/app/data

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/electron ./electron
COPY --from=build /app/package.json ./package.json

RUN mkdir -p /app/data
EXPOSE 3737

CMD ["node", "server/index.cjs"]
