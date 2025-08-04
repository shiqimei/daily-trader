#!/usr/bin/env -S npx tsx

import { spawn } from 'child_process'

const startChrome = () => {
  const chromeArgs = [
    '--remote-debugging-port=9222',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-web-security',
    '--disable-features=IsolateOrigins,site-per-process',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1920,1080',
    '--start-maximized',
    '--user-data-dir=/tmp/chrome-user-data',
    '--memory-pressure-off',
    '--max_old_space_size=1024',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--aggressive-cache-discard',
    '--aggressive-tab-discard',
    'https://www.binance.com/en/futures/ETHUSDC'
  ]

  const chrome = spawn('google-chrome', chromeArgs, {
    stdio: 'inherit',
    env: { ...process.env, DISPLAY: ':1' }
  })

  chrome.on('exit', code => {
    console.log(`Chrome exited with code ${code}, restarting...`)
    setTimeout(startChrome, 1000)
  })

  chrome.on('error', err => {
    console.error('Chrome error:', err)
    setTimeout(startChrome, 1000)
  })
}

startChrome()
