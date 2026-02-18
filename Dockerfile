FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY server/package*.json ./server/

# Install dependencies
WORKDIR /app/server
RUN npm install

# Copy application files
WORKDIR /app
COPY server/ ./server/
COPY public/ ./public/
COPY missions/ ./missions/

# Expose port
EXPOSE 3000

# Start server
WORKDIR /app/server
CMD ["node", "server.js"]
