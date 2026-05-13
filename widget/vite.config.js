import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5174,
    host: true,
  },
  build: {
    lib: {
      entry: 'src/index.js',
      name: 'FeedbackAssistant',
      formats: ['iife'],
      fileName: () => 'feedback-assistant.js',
    },
    outDir: 'dist',
    emptyOutDir: true,
    minify: 'terser',
    cssCodeSplit: false,
  },
});
