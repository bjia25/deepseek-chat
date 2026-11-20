FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
COPY server.js ./
COPY public ./public

# 内置 node 用户，避免以 root 运行
USER node

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
