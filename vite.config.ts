import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

// __dirname does not exist in ES modules, and package.json sets "type": "module".
// import.meta.url is the ESM replacement, and fileURLToPath turns it back into a normal path.
const entry = (file: string) => fileURLToPath(new URL(file, import.meta.url))

export default defineConfig({
  build: {
    rollupOptions: {
      // Two entry points, two independent module graphs.
      // The lab never imports the game, so a UI rewrite cannot break it. See docs/ROADMAP.md phase 1.
      input: {
        main: entry('index.html'),
        lab: entry('lab.html'),
      },
    },
  },
})
