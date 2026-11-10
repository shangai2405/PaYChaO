# The API and the built dashboard in one image. The engine is a CLI and runs
# next to the application under test, not here.
FROM node:22-alpine AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:22-alpine AS api
WORKDIR /src/api
COPY api/package.json api/package-lock.json ./
RUN npm ci
COPY api/ ./
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 STATIC_DIR=/app/web/dist
WORKDIR /app/api
COPY --from=api /src/api/dist ./dist
COPY --from=api /src/api/node_modules ./node_modules
COPY --from=api /src/api/package.json ./
COPY api/migrations ./migrations
COPY --from=web /src/web/dist /app/web/dist
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
