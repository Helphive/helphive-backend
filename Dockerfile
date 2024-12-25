FROM node:22.12.0-alpine

WORKDIR /app

COPY package.json package-lock.json ./

# Install dependencies using npm
RUN npm install

# Copy the rest of the application code
COPY . .

# Compile TypeScript files
RUN npm run build

# Expose the application port
EXPOSE 8080

# Start the application using the compiled JavaScript file
CMD ["node", "dist/index.js"]