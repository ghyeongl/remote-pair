import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { viteSingleFile } from 'vite-plugin-singlefile'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// This onboarding loads INSIDE XpairHost.app's WKWebView over file://. WKWebView blocks
// external `<script type="module" crossorigin src="./assets/…">` over file:// (CORS), which left
// the window blank. viteSingleFile() inlines all JS/CSS into one index.html (no external module
// fetch), so it renders via file://. Keep base './' for any residual relative refs.
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss(), viteSingleFile()],
  resolve: {
    alias: [
      { find: '@shared', replacement: path.resolve(__dirname, '../../shared/onboarding-ui') },
      { find: '@/components/ui', replacement: path.resolve(__dirname, '../../shared/onboarding-ui/components/ui') },
      { find: '@/hooks/use-locale', replacement: path.resolve(__dirname, '../../shared/onboarding-ui/hooks/use-locale.ts') },
      { find: '@/lib/utils', replacement: path.resolve(__dirname, '../../shared/onboarding-ui/lib/utils.ts') },
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
  build: { outDir: 'dist' },
})
