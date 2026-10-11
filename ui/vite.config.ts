import react from '@vitejs/plugin-react'
import { defineConfig, lazyPlugins } from 'vite-plus'

export default defineConfig({
  plugins: lazyPlugins(() => [react()]),
  clearScreen: false,
  // An explicit IPv4 address: with `localhost`, Node may bind only [::1], and VS Code's port
  // forwarding (dev container) connects to 127.0.0.1, so the page never loads. Tauri's devUrl
  // uses the same address.
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  build: { target: 'es2023', sourcemap: false },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    // Lets tests read index.css via ?raw (CSS is stubbed out by default).
    css: { include: [/index.css/] },
  },
  // The code's existing style: single quotes, no semicolons, long lines.
  fmt: {
    singleQuote: true,
    semi: false,
    printWidth: 140,
    // .impeccable holds the design tool's own state.
    ignorePatterns: ['dist/**', 'public/**', '.impeccable/**', '*.md'],
  },
  lint: {
    plugins: ['react', 'typescript', 'oxc'],
    rules: {
      'react/rules-of-hooks': 'error',
      'react/only-export-components': ['warn', { allowConstantExport: true }],
      'vite-plus/prefer-vite-plus-imports': 'error',
    },
    options: { typeAware: true, typeCheck: true },
    jsPlugins: [{ name: 'vite-plus', specifier: 'vite-plus/oxlint-plugin' }],
  },
})
