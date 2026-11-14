import { defineConfig, type Plugin } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import netlify from '@netlify/vite-plugin-tanstack-start'

const DB_CLIENT_STUB = '\0db-client-stub'

/**
 * The database client (and its Postgres driver) is server-only. Server-function and API route
 * files import it at the top level, so without this the driver ended up in the browser bundle,
 * crashed on load ("Buffer is not defined") and left the page unclickable. In the browser build
 * `db/index` is replaced with an empty stub; the server build is unchanged.
 */
function dbClientStub(): Plugin {
  return {
    name: 'db-client-stub',
    enforce: 'pre',
    resolveId(id) {
      if (this.environment.config.consumer !== 'client') return null
      if (/(^|\/)db\/index(\.[jt]s)?$/.test(id)) return DB_CLIENT_STUB
      return null
    },
    load(id) {
      if (id !== DB_CLIENT_STUB) return null
      return `export const db = new Proxy({}, { get() { throw new Error('db is server-only') } })`
    },
  }
}

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [dbClientStub(), tailwindcss(), netlify(), tanstackStart(), viteReact()],
})

export default config
