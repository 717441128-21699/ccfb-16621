import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// worklet 必须作为独立 JS 文件输出（AudioWorklet.addModule 不能加载内联模块），
// 因此用 rollup 多入口显式打包；主线程通过 ?url 资源导入引用产出的 URL
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    sourcemap: true,
    assetsInlineLimit: 0, // 禁止资源内联为 data URI，保证 worklet 是独立文件
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        simulatorSourceWorklet: resolve(__dirname, 'src/worklets/simulatorSource.worklet.ts'),
        correctorWorklet: resolve(__dirname, 'src/worklets/corrector.worklet.ts'),
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name.includes('Worklet')
            ? 'worklets/[name].js'
            : 'assets/[name]-[hash].js',
      },
    },
  },
  server: {
    port: 5173,
  },
});
