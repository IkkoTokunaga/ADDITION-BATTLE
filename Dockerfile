FROM node:22-alpine

WORKDIR /app

# Install development dependencies
RUN apk add --no-cache libc6-compat

COPY package*.json ./
RUN npm install

EXPOSE 4321

CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
