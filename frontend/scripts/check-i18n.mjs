import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const localesDir = fileURLToPath(new URL('../src/i18n/locales/', import.meta.url))
const flattenKeys = (value, prefix = '') => Object.entries(value).flatMap(([key, child]) => {
  const fullKey = prefix ? `${prefix}.${key}` : key
  return child && typeof child === 'object' && !Array.isArray(child)
    ? flattenKeys(child, fullKey)
    : [fullKey]
}).sort()

const files = (await readdir(localesDir)).filter((file) => file.endsWith('.json')).sort()
const localeKeys = new Map()
for (const file of files) {
  localeKeys.set(file, flattenKeys(JSON.parse(await readFile(join(localesDir, file), 'utf8'))))
}

const baseFile = 'en.json'
const baseKeys = localeKeys.get(baseFile)
if (!baseKeys) throw new Error(`Missing base locale: ${baseFile}`)

let failed = false
for (const [file, keys] of localeKeys) {
  if (file === baseFile) continue
  const missing = baseKeys.filter((key) => !keys.includes(key))
  const extra = keys.filter((key) => !baseKeys.includes(key))
  if (missing.length || extra.length) {
    failed = true
    console.error(`\n[ERROR] Parity mismatch in ${file}:`)
    if (missing.length) {
      console.error(`  Missing keys (${missing.length}):`)
      missing.forEach((k) => console.error(`    - ${k}`))
    }
    if (extra.length) {
      console.error(`  Extra keys (${extra.length}):`)
      extra.forEach((k) => console.error(`    + ${k}`))
    }
  }
}

if (failed) {
  console.error('\nCI failure: i18n locale keys are out of parity with en.json.')
  process.exit(1)
}
console.log(`i18n parity check passed for ${files.join(', ')}`)
