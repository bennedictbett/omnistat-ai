import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@': resolve(__dirname, '.') } },
  esbuild: { jsx: 'automatic' },
  test: { environment: 'jsdom', include: ['tests/**/*.test.{ts,tsx}'] },
})
