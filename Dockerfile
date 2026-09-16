FROM public.ecr.aws/docker/library/node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src
COPY views ./views
COPY public ./public
COPY sql ./sql

EXPOSE 4001

CMD ["sh", "-c", "node src/migrate.js && node src/app.js"]
