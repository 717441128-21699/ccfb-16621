import { defineConfig } from 'vite';
import { audioWorkletPlugin } from './plugins/worklet-plugin';

export default defineConfig({
  base: './',
  plugins: [audioWorkletPlugin()],
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
  },
});
