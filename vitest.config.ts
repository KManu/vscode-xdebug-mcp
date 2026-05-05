import { defineConfig } from 'vitest/config';
import * as path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    pool: 'forks',
    globals: true,
    setupFiles: [],
  },
  resolve: {
    alias: {
      src: path.resolve(__dirname, './src'),
    },
  },
});