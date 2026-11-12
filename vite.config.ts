import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * 前端由 Vite 编译。开发时不单独占端口，挂进 Node 宿主的中间件。
 * 见 src/server.ts。
 */
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
