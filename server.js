// server.js  -- proxy iThenticate -> PDF oficial
import express from "express";
import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";
import os from "os";

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.PROXY_API_KEY || process.env.API_KEY;
const USER = process.env.ITHENTICATE_USERNAME;
const PASS = process.env.ITHENTICATE_PASSWORD;
const RENDER_WAIT_MS = parseInt(process.env.RENDER_WAIT_MS || "8000", 10);
const DOWNLOAD_TIMEOUT_MS = 120_000;

const app = express();
app.use(express.json({ limit: "2mb" }));

const log = (...a) => console.log("[proxy]", ...a);

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    apiKey: !!API_KEY,
    ithenticate: !!(USER && PASS),
  });
});

async function launchBrowser(downloadDir) {
  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--single-process",
      "--window-size=1400,1000",
    ],
  });
  return browser;
}

async function login(page) {
  log("login -> https://app.ithenticate.com/en_us/login");
  await page.goto("https://app.ithenticate.com/en_us/login", {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });

  // Wait for either email or password input
  let ok = false;
  for (let i = 0; i < 30; i++) {
    const has = await page.evaluate(() => {
      return !!(
        document.querySelector('input[type="email"], input[name="email"], input[name="username"], input[id*="email" i], input[id*="user" i]') &&
        document.querySelector('input[type="password"]')
      );
    });
    if (has) { ok = true; break; }
    await new Promise(r => setTimeout(r, 500));
  }
  if (!ok) {
    const head = await page.evaluate(() => document.documentElement.outerHTML.slice(0, 600));
    log("login HTML head:", head);
    throw new Error("login form not found");
  }

  await page.evaluate((u, p) => {
    const email = document.querySelector('input[type="email"], input[name="email"], input[name="username"], input[id*="email" i], input[id*="user" i]');
    const pwd   = document.querySelector('input[type="password"]');
    if (email) { email.focus(); email.value = u; email.dispatchEvent(new Event("input", {bubbles:true})); }
    if (pwd)   { pwd.focus();   pwd.value = p;   pwd.dispatchEvent(new Event("input", {bubbles:true})); }
  }, USER, PASS);

  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => null),
    page.evaluate(() => {
      const btn = document.querySelector('button[type="submit"], input[type="submit"]');
      if (btn) btn.click();
      else document.querySelector("form")?.submit();
    }),
  ]);
  log("login done, url:", page.url());
}

async function clickDownload(page) {
  // Try selectors first
  const selectors = [
    'a[title*="Download" i]',
    'a[aria-label*="Download" i]',
    'button[title*="Download" i]',
    'button[aria-label*="Download" i]',
    'a[href*="download"]',
    '#download', '.download', '.dl-icon', '.icon-download',
    'a[title*="Print" i]', 'button[title*="Print" i]',
  ];

  const frames = [page, ...page.frames()];
  for (const f of frames) {
    for (const sel of selectors) {
      try {
        const el = await f.$(sel);
        if (el) {
          log("clicking selector:", sel, "in", f === page ? "main" : "frame");
          await el.click().catch(() => {});
          return true;
        }
      } catch {}
    }
  }

  // Text-based fallback
  for (const f of frames) {
    const clicked = await f.evaluate(() => {
      const all = Array.from(document.querySelectorAll("a, button, [role=button]"));
      const m = all.find(e => {
        const t = (e.innerText || e.textContent || "").trim().toLowerCase();
        const title = (e.getAttribute("title") || "").toLowerCase();
        const aria  = (e.getAttribute("aria-label") || "").toLowerCase();
        return /download|descargar|print|imprimir/.test(t + " " + title + " " + aria);
      });
      if (m) { m.click(); return true; }
      return false;
    }).catch(() => false);
    if (clicked) { log("clicked via text match"); return true; }
  }

  return false;
}

app.post("/report-pdf", async (req, res) => {
  if (!API_KEY || req.headers["x-api-key"] !== API_KEY) {
    return res.status(401).json({ error: "unauthorized" });
  }
  if (!USER || !PASS) {
    return res.status(500).json({ error: "missing iThenticate credentials" });
  }
  const { viewUrl } = req.body || {};
  if (!viewUrl || typeof viewUrl !== "string") {
    return res.status(400).json({ error: "missing viewUrl" });
  }

  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), "ith-"));
  let browser;
  try {
    browser = await launchBrowser(downloadDir);
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 1000 });

    // 1) Capture any application/pdf response
    let capturedPdf = null;
    const pdfPromise = new Promise((resolve) => {
      page.on("response", async (resp) => {
        try {
          const ct = (resp.headers()["content-type"] || "").toLowerCase();
          const url = resp.url();
          if (ct.includes("application/pdf") || /\.pdf(\?|$)/i.test(url)) {
            log("intercepted PDF response:", url, ct);
            const buf = await resp.buffer().catch(() => null);
            if (buf && buf.length > 200 && buf.slice(0,4).toString() === "%PDF") {
              capturedPdf = buf;
              resolve(buf);
            }
          }
        } catch {}
      });
    });

    // 2) Force any download to land in downloadDir
    const client = await page.target().createCDPSession();
    await client.send("Page.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: downloadDir,
    });

    // 3) Login
    await login(page);

    // 4) Open the view-only report
    log("open report:", viewUrl);
    await page.goto(viewUrl, { waitUntil: "networkidle2", timeout: 90_000 });
    await new Promise(r => setTimeout(r, RENDER_WAIT_MS));

    // 5) Click download/print
    const clicked = await clickDownload(page);
    if (!clicked) {
      log("no download control found");
      // dump some info to help debug
      const titles = await page.evaluate(() => {
        return Array.from(document.querySelectorAll("a, button"))
          .map(e => (e.getAttribute("title") || e.getAttribute("aria-label") || e.innerText || "").trim())
          .filter(Boolean).slice(0, 40);
      });
      log("candidates:", titles);
      throw new Error("download button not found");
    }

    // 6) Wait for either an HTTP-intercepted PDF or a downloaded file
    const startedAt = Date.now();
    let pdfBuf = null;

    while (Date.now() - startedAt < DOWNLOAD_TIMEOUT_MS && !pdfBuf) {
      if (capturedPdf) { pdfBuf = capturedPdf; break; }
      // poll downloadDir for a stable .pdf
      const files = fs.readdirSync(downloadDir).filter(f => f.toLowerCase().endsWith(".pdf"));
      if (files.length) {
        const fp = path.join(downloadDir, files[0]);
        const s1 = fs.statSync(fp).size;
        await new Promise(r => setTimeout(r, 1500));
        const s2 = fs.statSync(fp).size;
        if (s1 === s2 && s2 > 200) {
          pdfBuf = fs.readFileSync(fp);
          if (pdfBuf.slice(0,4).toString() !== "%PDF") pdfBuf = null;
          else break;
        }
      }
      await new Promise(r => setTimeout(r, 1000));
    }

    if (!pdfBuf) {
      // give the interceptor a last chance
      pdfBuf = await Promise.race([
        pdfPromise,
        new Promise(r => setTimeout(() => r(null), 5000)),
      ]);
    }

    if (!pdfBuf) {
      throw new Error("official PDF not received within timeout");
    }

    log("returning official PDF, bytes:", pdfBuf.length);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Length", pdfBuf.length);
    res.end(pdfBuf);
  } catch (e) {
    log("ERROR:", e?.message || e);
    res.status(500).json({ error: String(e?.message || e) });
  } finally {
    try { await browser?.close(); } catch {}
    try { fs.rmSync(downloadDir, { recursive: true, force: true }); } catch {}
  }
});

app.listen(PORT, () => log("listening on", PORT));

