FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js migrate-data.js ./
COPY lib ./lib
COPY public ./public
USER 1002:1002
EXPOSE 3300
CMD ["node", "server.js"]
