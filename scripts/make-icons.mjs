// Renders store/icon-source.svg to icons/icon-{16,32,48,128}.png with Playwright (transparent background).
// The 128 px icon keeps the artwork inside a 96 px box with transparent padding; smaller sizes use less padding.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { root } from './build.mjs';
import { chromium } from 'playwright-core';

const executablePath = process.env.BROWSER_PATH ?? 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe';
const svg = readFileSync(path.join(root, 'store', 'icon-source.svg'), 'utf8');
const SIZES = { 16: 0, 32: 2, 48: 3, 128: 16 }; // transparent padding in px at that size

mkdirSync(path.join(root, 'icons'), { recursive: true });
const browser = await chromium.launch({ executablePath, headless: true });
try {
  for (const [size, pad] of Object.entries(SIZES)) {
    const page = await browser.newPage({ viewport: { width: Number(size), height: Number(size) } });
    const inner = Number(size) - pad * 2;
    await page.setContent(
      `<body style="margin:0;background:transparent"><div style="width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center">` +
        `<div style="width:${inner}px;height:${inner}px">${svg.replace('<svg', '<svg width="100%" height="100%"')}</div></div></body>`,
    );
    const png = await page.screenshot({ omitBackground: true, type: 'png' });
    writeFileSync(path.join(root, 'icons', `icon-${size}.png`), png);
    await page.close();
    console.log(`icons/icon-${size}.png (${png.length} bytes)`);
  }
} finally {
  await browser.close();
}
