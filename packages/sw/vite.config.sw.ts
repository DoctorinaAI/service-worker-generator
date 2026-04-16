import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { resolve } from 'path';

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    target: 'es2022',
    minify: 'esbuild',
    lib: {
      entry: resolve(__dirname, 'src/sw/index.ts'),
      name: 'sw',
      formats: ['iife'],
      fileName: () => 'sw.js',
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
  plugins: [viteSingleFile()],
});
