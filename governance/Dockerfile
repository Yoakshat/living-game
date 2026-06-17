FROM node:18-alpine
RUN apk add --no-cache git
WORKDIR /app
COPY package.json ./
COPY index.js ./
EXPOSE 4000
CMD ["node", "index.js"]
