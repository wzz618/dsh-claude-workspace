// The browser half is authored in the DSH client module-loader format, which is
// not ESM and therefore cannot pass through tsc. Copy it into lib/ unchanged.
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
mkdirSync(join(root, 'lib'), { recursive: true })
copyFileSync(join(root, 'src', 'client.js'), join(root, 'lib', 'client.js'))
