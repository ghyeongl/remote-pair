import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// Version — derived from the shared monotonic build counter (LOCKSTEP with the host: same
// 0.5.0a base + shared/.build-counter). This only READS the current value (display stamp); the
// counter is bumped by the host/client build scripts. repo root is 5 levels up.
const APP_VERSION = (() => {
  try {
    const n = readFileSync(path.resolve(__dirname, '../../../../../shared/.build-counter'), 'utf8').trim()
    return `0.5.0a${n}`
  } catch {
    return '0.5.0a'
  }
})()
// Build stamp = version + a fresh timestamp in KST (Asia/Seoul, UTC+9 — the team's timezone), so a
// launched window shows the 0.5.0aN naming AND is verifiably the latest build (re-evaluated on each
// `vite build`). Shift UTC by +9h then format the wall-clock. e.g. "0.5.0a1 · 06-17 19:40:12 KST".
const _kst = new Date(Date.now() + 9 * 60 * 60 * 1000)
const BUILD_ID = `${APP_VERSION} · ${_kst.toISOString().slice(5, 19).replace('T', ' ')} KST`

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID),
  },
  resolve: {
    alias: [
      { find: '@shared', replacement: path.resolve(__dirname, '../../../../../shared/onboarding-ui') },
      { find: '@/components/ui', replacement: path.resolve(__dirname, '../../../../../shared/onboarding-ui/components/ui') },
      { find: '@/hooks/use-locale', replacement: path.resolve(__dirname, '../../../../../shared/onboarding-ui/hooks/use-locale.ts') },
      { find: '@/lib/utils', replacement: path.resolve(__dirname, '../../../../../shared/onboarding-ui/lib/utils.ts') },
      { find: '@', replacement: path.resolve(__dirname, 'src') },
      { find: /^@radix-ui\/react-slot$/, replacement: require.resolve('@radix-ui/react-slot') },
      { find: /^class-variance-authority$/, replacement: require.resolve('class-variance-authority') },
      { find: /^clsx$/, replacement: require.resolve('clsx') },
      { find: /^lucide-react$/, replacement: require.resolve('lucide-react') },
      { find: /^react$/, replacement: require.resolve('react') },
      { find: /^react-dom$/, replacement: require.resolve('react-dom') },
      { find: /^react\/jsx-runtime$/, replacement: require.resolve('react/jsx-runtime') },
      { find: /^tailwind-merge$/, replacement: require.resolve('tailwind-merge') },
    ],
  },
  build: {
    outDir: 'dist',
  },
})
