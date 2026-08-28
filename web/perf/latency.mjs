#!/usr/bin/env node
/**
 * Glass-to-glass latency and bandwidth rig.
 *
 * Runs the viewer in headless Chromium against a console, connects to a device whose agent
 * runs the synthetic source (`REMOTE_AGENT_SYNTHETIC_SOURCE=1`), and for each scenario
 * collects: latency samples decoded from the strip the synthetic source draws (median / p95),
 * bytes received per second (`getStats()`), and decoded frames per second.
 *
 *   npm run perf:latency -- --console http://127.0.0.1:18080 --email admin@example.com \
 *       --password '…' --device dev_xxx --scenarios static,typing,drag,video \
 *       --agent-cmd '/path/to/remote-agent --config-dir /tmp/rig run' [--seconds 20] [--out perf/results.json]
 *
 * With `--agent-cmd` the script (re)starts the agent per scenario with
 * `REMOTE_AGENT_SYNTHETIC_SOURCE=1 REMOTE_AGENT_SYNTHETIC_SCENARIO=<name>`; without it, it
 * prints the command to run and waits for Enter before each scenario.
 *
 * Playwright is resolved from `PLAYWRIGHT_MODULE` (default `playwright`; e.g. point it at
 * another project's node_modules/playwright/index.mjs when it is not installed here).
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

const args = parseArgs(process.argv.slice(2))
const CONSOLE = args.console ?? 'http://127.0.0.1:18080'
const SECONDS = Number(args.seconds ?? 20)
const SCENARIOS = String(args.scenarios ?? 'static,typing,drag,video').split(',').map((s) => s.trim()).filter(Boolean)
const OUT = args.out ?? path.join(process.cwd(), 'perf', 'results.json')
if (!args.device || !args.email || !args.password) {
  console.error('usage: latency.mjs --console URL --email E --password P --device dev_id [--scenarios a,b] [--agent-cmd "…"] [--seconds 20] [--out file]')
  process.exit(2)
}

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')

const results = []
let agentProc = null

for (const scenario of SCENARIOS) {
  await startAgent(scenario)
  const r = await measure(scenario)
  results.push(r)
  console.log(formatRow(r))
}
stopAgent()

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify({ console: CONSOLE, device: args.device, seconds: SECONDS, at: new Date().toISOString(), results }, null, 2))
console.log(`\nJSON written to ${OUT}\n\nPaste into remote-agent/PERFORMANCE.md under "## Results":\n`)
console.log(markdownTable(results))

/* ───────────── helpers ───────────── */

async function measure(scenario) {
  const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] })
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.error('[page error]', String(e).slice(0, 200)))
  await page.goto(`${CONSOLE}/login`)
  await page.getByRole('textbox', { name: 'Email' }).fill(args.email)
  await page.getByRole('textbox', { name: 'Password' }).fill(args.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/\/devices/)
  await page.goto(`${CONSOLE}/viewer/${args.device}?debug=1&perf=1`)
  await page.getByText('Live', { exact: false }).first().waitFor({ timeout: 30000 })
  // Let the first keyframe and the probe settle.
  await page.waitForTimeout(2000)
  await page.evaluate(() => window.__viewerDebug?.latencyReset?.())
  const bytesStart = await page.evaluate(() => window.__viewerDebug?.rtcBytes?.() ?? null)
  const t0 = Date.now()
  await page.waitForTimeout(SECONDS * 1000)
  const elapsed = (Date.now() - t0) / 1000
  const bytesEnd = await page.evaluate(() => window.__viewerDebug?.rtcBytes?.() ?? null)
  const lat = await page.evaluate(() => window.__viewerDebug?.latencySnapshot?.() ?? null)
  const agentStats = await page.evaluate(() => window.__viewerDebug?.agentStats?.() ?? null)
  await browser.close()
  const kbps = bytesStart !== null && bytesEnd !== null ? ((bytesEnd.bytes - bytesStart.bytes) * 8) / elapsed / 1000 : null
  const fps = bytesStart !== null && bytesEnd !== null ? (bytesEnd.framesDecoded - bytesStart.framesDecoded) / elapsed : null
  return {
    scenario,
    seconds: elapsed,
    samples: lat?.samples?.length ?? 0,
    decodeFailures: lat?.decodeFailures ?? null,
    medianMs: lat?.medianMs ?? null,
    p95Ms: lat?.p95Ms ?? null,
    kbps,
    fps,
    agent: agentStats,
  }
}

async function startAgent(scenario) {
  if (!args['agent-cmd']) {
    console.log(`\nScenario "${scenario}": start the agent with\n  REMOTE_AGENT_SYNTHETIC_SOURCE=1 REMOTE_AGENT_SYNTHETIC_SCENARIO=${scenario} remote-agent --config-dir <dir> run\nthen press Enter…`)
    await waitForEnter()
    return
  }
  stopAgent()
  const [cmd, ...rest] = splitCommand(args['agent-cmd'])
  agentProc = spawn(cmd, rest, { env: { ...process.env, REMOTE_AGENT_SYNTHETIC_SOURCE: '1', REMOTE_AGENT_SYNTHETIC_SCENARIO: scenario }, stdio: ['ignore', 'ignore', 'inherit'] })
  console.log(`\nScenario "${scenario}": agent started (pid ${agentProc.pid}), waiting for it to connect…`)
  await new Promise((r) => setTimeout(r, 5000))
}

function stopAgent() {
  if (agentProc && !agentProc.killed) agentProc.kill('SIGTERM')
  agentProc = null
}

function formatRow(r) {
  const f = (v, d = 0) => (v === null || v === undefined ? '—' : Number(v).toFixed(d))
  return `${r.scenario.padEnd(8)} latency median ${f(r.medianMs)} ms  p95 ${f(r.p95Ms)} ms  ${f(r.kbps)} kbit/s  ${f(r.fps, 1)} fps  (${r.samples} samples, ${r.decodeFailures ?? '—'} undecodable)`
}

function markdownTable(rows) {
  const f = (v, d = 0) => (v === null || v === undefined ? '—' : Number(v).toFixed(d))
  const lines = ['| Scenario | Latency median | Latency p95 | Bandwidth | Decoded fps | Samples |', '|----------|---------------|-------------|-----------|-------------|---------|']
  for (const r of rows) lines.push(`| ${r.scenario} | ${f(r.medianMs)} ms | ${f(r.p95Ms)} ms | ${f(r.kbps)} kbit/s | ${f(r.fps, 1)} | ${r.samples} |`)
  return lines.join('\n')
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        out[key] = next
        i++
      } else out[key] = true
    }
  }
  return out
}

function splitCommand(s) {
  const parts = []
  let cur = ''
  let quote = null
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
    } else if (ch === '"' || ch === "'") quote = ch
    else if (/\s/.test(ch)) {
      if (cur) parts.push(cur)
      cur = ''
    } else cur += ch
  }
  if (cur) parts.push(cur)
  return parts
}

function waitForEnter() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => rl.question('', () => { rl.close(); resolve() }))
}
