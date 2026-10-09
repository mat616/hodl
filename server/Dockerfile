FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
ENV NODE_ENV=production
EXPOSE 8787
CMD ["npx", "tsx", "src/index.ts"]
