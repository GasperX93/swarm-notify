import { defineConfig } from 'vite'
import path from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '@lib': path.resolve(__dirname, '../../src'),
    },
  },
  optimizeDeps: {
    include: ['@noble/secp256k1', '@noble/hashes', '@ethersphere/bee-js', 'ethers'],
  },
})
