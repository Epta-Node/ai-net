import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

/**
 * Resolve the npm package a module id belongs to, anchored to the package
 * root (handles scoped and nested node_modules). Returns null for app code.
 */
function packageName(id: string): string | null {
  const marker = 'node_modules/';
  const idx = id.lastIndexOf(marker);
  if (idx === -1) return null;
  const parts = id.slice(idx + marker.length).split('/');
  return parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
}

const oneOf =
  (...names: string[]) =>
  (pkg: string) =>
    names.includes(pkg);

/**
 * A handful of meaningful vendor chunks. Matching is by exact package name,
 * never by substring, so e.g. `reactflow` or `react-markdown` do not land in
 * the always-loaded `vendor-react` chunk. Groups only used by lazy routes
 * (flow, charts, pdf, markdown) are fetched with those routes.
 */
const VENDOR_GROUPS: Array<[string, (pkg: string) => boolean]> = [
  [
    'vendor-react',
    oneOf(
      'react',
      'react-dom',
      'scheduler',
      'react-router',
      'react-router-dom',
      '@remix-run/router'
    ),
  ],
  ['vendor-i18n', oneOf('i18next', 'react-i18next', 'i18next-browser-languagedetector')],
  ['vendor-motion', oneOf('framer-motion', 'motion-dom', 'motion-utils')],
  ['vendor-stellar', (pkg) => pkg.startsWith('@stellar/')],
  ['vendor-flow', (pkg) => pkg === 'reactflow' || pkg.startsWith('@reactflow/')],
  ['vendor-charts', oneOf('recharts', 'recharts-scale', 'victory-vendor')],
  ['vendor-pdf', oneOf('jspdf', 'jspdf-autotable', 'html2canvas', 'canvg')],
  [
    'vendor-markdown',
    (pkg) =>
      [
        'react-markdown',
        'react-syntax-highlighter',
        'refractor',
        'prismjs',
        'highlight.js',
        'lowlight',
        'unified',
      ].includes(pkg) || /^(remark|rehype|micromark|mdast|hast|unist)(-|$)/.test(pkg),
  ],
];

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@services': path.resolve(__dirname, './src/services'),
      '@utils': path.resolve(__dirname, './src/utils'),
    },
  },
  server: {
    port: 3000,
  },
  build: {
    manifest: true,
    // Warn when an individual chunk exceeds 250kb (developer-specified budget)
    chunkSizeWarningLimit: 250,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          const pkg = packageName(id);
          if (!pkg) return undefined;
          for (const [chunk, matches] of VENDOR_GROUPS) {
            if (matches(pkg)) return chunk;
          }
          // Long-tail dependencies: let Rollup co-locate them with the
          // (lazy) route chunk that imports them instead of emitting one
          // tiny chunk per package.
          return undefined;
        },
      },
    },
  },
});
