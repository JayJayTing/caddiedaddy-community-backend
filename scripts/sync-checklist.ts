import { readFileSync, writeFileSync } from 'fs'
import { execSync } from 'child_process'
import { join, resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT       = resolve(__dirname, '..')
const CHECKLIST  = join(ROOT, 'BACKEND_CHECKLIST.md')
const SRC_ROUTES = join(ROOT, 'src', 'routes')

const content = readFileSync(CHECKLIST, 'utf-8')
let changed = 0

const lines = content.split('\n').map(line => {
  // Update "Last synced" timestamp line
  if (line.startsWith('> **Last synced:**')) {
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ') + ' UTC'
    return `> **Last synced:** ${now}`
  }

  const match = line.match(/<!-- sync: (.+?) -->/)
  if (!match) return line

  const pattern = match[1]
  let found = false
  try {
    execSync(`grep -r ${JSON.stringify(pattern)} "${SRC_ROUTES}"`, { stdio: 'pipe' })
    found = true
  } catch { /* pattern not found in source */ }

  const wasChecked = line.includes('- [x]')
  if (found && !wasChecked)  { changed++; return line.replace('- [ ]', '- [x]') }
  if (!found && wasChecked)  { changed++; return line.replace('- [x]', '- [ ]') }
  return line
})

// Recount progress after updates
const fullText = lines.join('\n')
const total   = (fullText.match(/<!-- sync:/g) || []).length
const done    = (fullText.match(/- \[x\].*<!-- sync:/g) || []).length

const finalLines = lines.map(line => {
  if (line.startsWith('> **Progress:**')) {
    return `> **Progress:** ${done} / ${total} routes implemented`
  }
  return line
})

writeFileSync(CHECKLIST, finalLines.join('\n'))

const ts = new Date().toISOString().slice(0, 19).replace('T', ' ')
console.log(`✓ Checklist synced at ${ts} UTC`)
console.log(`  ${done}/${total} routes implemented — ${changed} item(s) changed`)
