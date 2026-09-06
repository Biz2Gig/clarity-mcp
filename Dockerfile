FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
# Dev deps (vite, react-router/dev) are needed for the build step.
RUN npm ci

COPY . .
RUN npx prisma generate && npm run build

EXPOSE 3000
# Runs `prisma generate && prisma migrate deploy` then starts the server.
CMD ["npm", "run", "docker-start"]
