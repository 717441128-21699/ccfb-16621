/**
 * AudioWorklet 构建插件
 * --------------------
 * Vite 默认不会把 `.ts?url` 的 Worklet 入口编译成可在 AudioWorkletGlobalScope
 * 运行的独立 JS（会保留 .ts 或内联未转换源码）。本插件在构建期把两个 Worklet
 * 入口声明为独立 chunk，经正常 TS/ESBuild 转换后输出为纯 JS，并把 `?url`
 * 导入解析到产物文件名；开发模式下回退为源码路径（Vite dev 可直接转译 TS）。
 */
import type { Plugin, ResolvedConfig } from 'vite';

const WORKLET_ENTRIES: Record<string, string> = {
  'unscrambler-worklet': '/src/worklets/unscrambler-worklet.ts',
  'helium-sim-worklet': '/src/worklets/helium-sim-worklet.ts',
};

export function audioWorkletPlugin(): Plugin {
  let config: ResolvedConfig;
  const chunkIds = new Map<string, string>();

  return {
    name: 'audio-worklet-build',

    configResolved(resolved) {
      config = resolved;
    },

    // 开发模式：把 ?worklet-url 解析为带查询的真实模块路径
    async resolveId(source, importer, opts) {
      if (!source.endsWith('?worklet-url')) return null;
      if (config.command === 'serve') {
        const bare = source.replace('?worklet-url', '');
        const resolved = await this.resolve(bare, importer, { skipSelf: true, ...opts });
        if (!resolved) return null;
        // 保留查询，确保 load 钩子能识别
        return { id: `${resolved.id}?worklet-url` };
      }
      return { id: source, moduleSideEffects: false };
    },

    load(id) {
      if (!id.endsWith('?worklet-url')) return null;
      // 开发模式：导出浏览器可加载的根相对模块 URL（Vite dev 按需转译 TS）
      if (config.command === 'serve') {
        const bare = id.replace('?worklet-url', '');
        const rootRelative = bare.replace(/\\/g, '/').replace(config.root.replace(/\\/g, '/'), '');
        const browserUrl = rootRelative.startsWith('/') ? rootRelative : `/${rootRelative}`;
        return { code: `export default ${JSON.stringify(browserUrl)};`, moduleSideEffects: false };
      }
      const base = id.replace('?worklet-url', '');
      const name = base.split('/').pop()!.replace(/\.ts$/, '');
      const refId = chunkIds.get(name);
      if (!refId) throw new Error(`未知 worklet 入口: ${name}`);
      // 构建模式：由 Rollup 替换为产物文件 URL
      return {
        code: `export default import.meta.ROLLUP_FILE_URL_${refId};`,
        moduleSideEffects: false,
      };
    },

    buildStart() {
      if (config.command !== 'build') return;
      for (const [name, entry] of Object.entries(WORKLET_ENTRIES)) {
        const id = this.emitFile({
          type: 'chunk',
          id: entry,
          name,
          fileName: `assets/${name}.js`,
        });
        chunkIds.set(name, id);
      }
    },
  };
}
