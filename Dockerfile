FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
RUN apk add --no-cache curl
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/state && chown -R node:node /app
USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=5s --retries=3 --start-period=10s \
  CMD curl -sS -o /dev/null -w "%{http_code}" http://localhost:8080/ | grep -qE "^(200|404)$" || exit 1
CMD ["node", "dist/index.js"]
