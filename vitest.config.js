import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * Vitest config — co-locates with Vite so the same transformer pipeline runs
 * for tests. Tests live under `tests/unit/`; component tests need jsdom so
 * React Testing Library can mount components.
 *
 * To run:
 *   npm install --save-dev vitest @testing-library/react \
 *                          @testing-library/jest-dom jsdom
 *   npm test
 */
export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./tests/unit/setup.js'],
    css: false,
    include: ['tests/unit/**/*.test.{js,jsx}'],
  },
});
