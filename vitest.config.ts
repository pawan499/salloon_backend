import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 60000,
    hookTimeout: 120000,
    env: {
      NODE_ENV: 'test',
      MONGODB_URI: 'mongodb://127.0.0.1:27017/salon-test',
      JWT_ACCESS_SECRET: 'test-access-secret-00000000000000000000',
      JWT_REFRESH_SECRET: 'test-refresh-secret-1111111111111111111',
    },
  },
});
