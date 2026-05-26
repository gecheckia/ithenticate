// server.js — Proxy para descargar el PDF oficial de iThenticate
// Requisitos: node >= 18, puppeteer

import express from "express";
import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";
import os from "os";

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.PROXY_API_KEY || process.env.API_KEY;
const ITH_USER = process.env.ITHENTICATE_USERNAME;
const ITH_PASS = process.env.ITHENTICATE_PASSWORD;
const RENDER_WAIT_MS = parseInt(process.env.RENDER_WAIT_MS || "8000", 10);

if (!API_KEY) console.warn("[proxy] WARNING: PROXY_API_KEY not set");
if (!ITH_USER || !ITH_PASS) console.warn("[proxy] WARNING: ITHENTICATE_USERNAME/PASSWORD not set");

const app = express();
app.use(express.json({ limit: "2mb" }));

// ---------- helpers ----------

function checkAuth(req, res) {
  const key = req.header("x-api-key");
  if (!API_KEY) {
    res.status(500).json({ error: "PROXY_API_KEY not set" });
    return false;
  }
  if (key !== API_KEY) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

async function launchBrowser(downloadDir) {
  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-zygote",
      "--single-process",
      "--window-size=1400,1000",
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1000 });
  const client = await page.target().createCDPSession();
  await client.send("Page.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: downloadDir,
  });
  return { browser, page, client };
}

// ---------- login ----------

async function findLoginInputs(page) {
  const sel =
    'input[type="email"], input[name="email"], input[name="login"], input[name="username"], input#username, input#email, input#login';
  // intenta en la página principal
  const main = await page.$(sel);
  if (main) {
    const which = await main.evaluate((el) => {
      if (el.id) return `#${el.id}`;
      if (el.name) return `input[name="${el.name}"]`;
      return 'input[type="email"]';
    });
    return { frame: page, userSel: which };
  }
  // intenta en iframes
  for (const frame of page.frames()) {
    const el = await frame.$(sel).catch(() => null);
    if (el) {
      const which = await el.evaluate((node) => {
        if (node.id) return `#${node.id}`;
        if (node.name) return `input[name="${node.name}"]`;
        return 'input[type="email"]';
      });
      return { frame, userSel: which };
    }
  }
  return null;
}

async function login(page) {
  // Ir directo al endpoint de login real
  await page.goto("https://app.ithenticate.com/en_us/login", {
    waitUntil: "networkidle2",
    timeout: 60000,
  });

  let target = null;
  for (let i = 0; i < 30; i++) {
    target = await findLoginInputs(page);
    if (target) break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (!target) {
    const html = await page.content();
    console.error("[proxy] login HTML head:", html.slice(0, 2000));
    throw new Error("No se encontró el formulario de login de iThenticate");
  }

  await target.frame.waitForSelector('input[type="password"]', { timeout: 30000 });

  await target.frame.type(target.userSel, ITH_USER, { delay: 25 });
  await target.frame.type('input[type="password"]', ITH_PASS, { delay: 25 });

  await Promise.all([
    page
      .waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 })
      .catch(() => {}),
    target.frame
      .click('button[type="submit"], input[type="submit"]')
      .catch(async () => {
        await page.keyboard.press("Enter");
      }),
  ]);
}

// ---------- descarga del PDF desde el visor ----------

async function clickDownloadInViewer(page) {
  // Espera a que el visor cargue
  await new Promise((r) => setTimeout(r, RENDER_WAIT_MS));

  const selectors = [
    'a[title*="Download" i]',
    'button[title*="Download" i]',
    'a[aria-label*="Download" i]',
    'button[aria-label*="Download" i]',
    'a[title*="Print" i]',
    'button[title*="Print" i]',
    'a[aria-label*="Print" i]',
    'button[aria-label*="Print" i]',
    'a[href*="download"]',
    '.print-button',
    '#print',
    '.icon-print',
    '.icon-download',
  ];

  const tryClick = async (ctx) => {
    for (const sel of selectors) {
      const el = await ctx.$(sel).catch(() => null);
      if (el) {
        await ctx
          .evaluate((node) => {
            const target = node.closest("a") || node;
            target.click();
          }, el)
          .catch(() => {});
        return true;
      }
    }
    // fallback: buscar por texto
    const found = await ctx
      .evaluate(() => {
        const all = Array.from(document.querySelectorAll("a, button"));
        const hit = all.find((n) => /print|download|descargar|imprimir/i.test(n.textContent || n.getAttribute("title") || n.getAttribute("aria-label") || ""));
        if (hit) {
          (hit.closest("a") || hit).click();
          return true;
        }
        return false;
      })
      .catch(() => false);
    return found;
  };

  // Página principal
  if (await tryClick(page)) return true;
  // Iframes
  for (const frame of page.frames()) {
    if (await tryClick(frame)) return true;
  }
  return false;
}

async function waitForPdf(dir, timeoutMs = 90000) {
  const start = Date.now();
  let lastSize = -1;
  let stableSince = 0;
  while (Date.now() - start < timeoutMs) {
    const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".pdf"));
    if (files.length > 0) {
      const full = path.join(dir, files[0]);
      const size = fs.statSync(full).size;
      if (size > 0 && size === lastSize) {
        if (Date.now() - stableSince > 1500) return full;
      } else {
        lastSize = size;
        stableSince = Date.now();
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

// ---------- rutas ----------

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    hasApiKey: !!API_KEY,
    hasIthCreds: !!(ITH_USER && ITH_PASS),
  });
});

app.post("/report-pdf", async (req, res) => {
  if (!checkAuth(req, res)) return;
  const { viewUrl } = req.body || {};
  if (!viewUrl || typeof viewUrl !== "string") {
    return res.status(400).json({ error: "viewUrl required" });
  }

  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), "ith-"));
  let browser;
  try {
    const ctx = await launchBrowser(downloadDir);
    browser = ctx.browser;
    const { page } = ctx;

    await login(page);

    await page.goto(viewUrl, { waitUntil: "networkidle2", timeout: 90000 });

    const clicked = await clickDownloadInViewer(page);
    if (!clicked) {
      const html = await page.content();
      console.error("[proxy] page snippet:", html.slice(0, 1500));
      throw new Error("Could not find download button in iThenticate viewer");
    }

    const pdfPath = await waitForPdf(downloadDir);
    if (!pdfPath) throw new Error("PDF download timed out");

    const buf = fs.readFileSync(pdfPath);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Length", buf.length);
    res.end(buf);
  } catch (err) {
    console.error("[proxy] /report-pdf error:", err?.message || err);
    res.status(500).json({ error: err?.message || "Unknown error" });
  } finally {
    if (browser) await browser.close().catch(() => {});
    try {
      fs.rmSync(downloadDir, { recursive: true, force: true });
    } catch {}
  }
});

app.listen(PORT, () => {
  console.log(`[proxy] listening on ${PORT}`);
});
