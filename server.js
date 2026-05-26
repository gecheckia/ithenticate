// server.js
import express from "express";
import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";
import os from "os";

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.PROXY_API_KEY || process.env.API_KEY;
const ITH_USER = process.env.ITHENTICATE_USERNAME;
const ITH_PASS = process.env.ITHENTICATE_PASSWORD;
const RENDER_WAIT_MS = parseInt(process.env.RENDER_WAIT_MS || "8000", 10);

// ---------- helpers ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function auth(req, res, next) {
  if (!API_KEY) return res.status(500).send("PROXY_API_KEY not set");
  if (req.header("x-api-key") !== API_KEY)
    return res.status(401).send("Unauthorized");
  next();
}

async function login(page) {
  if (!ITH_USER || !ITH_PASS) {
    throw new Error("ITHENTICATE_USERNAME / ITHENTICATE_PASSWORD not set");
  }
  await page.goto("https://www.ithenticate.com/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  // Esperar el form de login
  await page.waitForSelector('input[name="email"]', { timeout: 30000 });
  await page.type('input[name="email"]', ITH_USER, { delay: 20 });
  await page.type('input[name="password"]', ITH_PASS, { delay: 20 });
  await Promise.all([
    page.click('input[type="submit"], button[type="submit"]'),
    page.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 }),
  ]).catch(() => {});
}

async function triggerDownload(page) {
  await sleep(RENDER_WAIT_MS);

  const downloadSelectors = [
    "#dl_btn",
    "a#dl_btn",
    "button#dl_btn",
    '[title*="Download" i]',
    '[aria-label*="Download" i]',
    '[title*="Descargar" i]',
    'a[href*="download"]',
    'a[href*="dv_print"]',
    ".download-btn",
    ".dl-button",
    "#print_menu",
    "#print_btn",
  ];

  const subSelectors = [
    'a[href*="dv_print"]',
    'a[href*="current_view"]',
    "#current_view_pdf",
    'a[title*="Current View" i]',
    'a[title*="PDF" i]',
  ];

  const contexts = [page, ...page.frames()];

  for (const ctx of contexts) {
    for (const sel of downloadSelectors) {
      try {
        const el = await ctx.$(sel);
        if (!el) continue;
        console.log(`[proxy] found download via ${sel}`);
        await el.click().catch(() => {});
        await sleep(1500);

        for (const sub of subSelectors) {
          try {
            const subEl = await ctx.$(sub);
            if (subEl) {
              console.log(`[proxy] found submenu via ${sub}`);
              await subEl.click().catch(() => {});
              break;
            }
          } catch {}
        }
        return true;
      } catch {}
    }
  }

  const html = await page.content();
  console.error("[proxy] page snippet:", html.slice(0, 2000));
  throw new Error("Could not find download button in iThenticate viewer");
}

async function waitForPdf(dir, timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const files = fs.readdirSync(dir);
    const inProgress = files.find((f) => f.endsWith(".crdownload"));
    const pdf = files.find((f) => f.toLowerCase().endsWith(".pdf"));

    if (pdf && !inProgress) {
      const full = path.join(dir, pdf);
      // confirmar tamaño estable
      const size1 = fs.statSync(full).size;
      await sleep(800);
      const size2 = fs.statSync(full).size;
      if (size1 === size2 && size1 > 1000) return full;
    }
    await sleep(500);
  }
  throw new Error("Timed out waiting for PDF download");
}

// ---------- routes ----------

app.get("/health", (_req, res) => res.send("ok"));

app.post("/report-pdf", auth, async (req, res) => {
  const { viewUrl } = req.body || {};
  if (!viewUrl || typeof viewUrl !== "string") {
    return res.status(400).json({ error: "viewUrl required" });
  }

  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), "ith-"));
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
      ],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 1800 });

    // Forzar descargas reales al directorio
    const client = await page.target().createCDPSession();
    await client.send("Page.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: downloadDir,
    });

    await login(page);

    await page.goto(viewUrl, { waitUntil: "networkidle2", timeout: 90000 });

    await triggerDownload(page);

    const pdfPath = await waitForPdf(downloadDir);
    const buf = fs.readFileSync(pdfPath);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="ithenticate-report.pdf"',
    );
    res.setHeader("Content-Length", buf.length);
    res.end(buf);
  } catch (err) {
    console.error("[proxy] error:", err);
    res.status(500).json({ error: err.message || String(err) });
  } finally {
    if (browser) await browser.close().catch(() => {});
    try {
      fs.rmSync(downloadDir, { recursive: true, force: true });
    } catch {}
  }
});

app.listen(PORT, () => {
  console.log(`[proxy] listening on :${PORT}`);
});
