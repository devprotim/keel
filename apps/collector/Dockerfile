# The collector has no runtime dependencies: its only import from @keel/shared
# is types, which Node's type stripping erases. So the image is Node plus src/.
# Build from the repo root:  docker build -f apps/collector/Dockerfile -t keel-collector .
FROM node:22-alpine
WORKDIR /app
COPY apps/collector/package.json ./
COPY apps/collector/src ./src
RUN rm -f src/*.spec.ts src/fixtures.ts
# Numeric, so a pod with runAsNonRoot can verify it.
USER 1000
EXPOSE 4318
ENV NODE_ENV=production
CMD ["node", "--experimental-strip-types", "--no-warnings=ExperimentalWarning", "src/main.ts"]
