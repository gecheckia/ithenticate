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

// ---- helpers ----

function auth(req, res, next) {
  if (!API_KEY) return res.status(500).send("PROXY_API_KEY not set");
  if (req.header("x-api-key") !== API_KEY) return res.status(401).send("Unauthorized");
  next();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wait until a .pdf file appears in `dir` AND its size is stable.
async function waitForPdf(dir, timeoutMs = 90_000) {
  const start = Date.now();
  let lastSize = -1;
  let stableSince = 0;

  while (Date.now() - start < timeoutMs) {
    const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    // ignore Chromium's in-progress files (.crdownload)
    const pdf = files.find((f) => f.toLowerCase().endsWith(".pdf"));
    const inProgress = files.find((f) => f.endsWith(".crdownload"));

    if (pdf && !inProgress) {
      const full = path.join(dir, pdf);
      const size = fs.statSync(full).size;
      if (size > 0 && size === lastSize) {
        if (Date.now() - stableSince > 1500) return full;
      } else {
        lastSize = size;
        stableSince = Date.now();
      }
    }
    await sleep(400);
  }
  throw new Error("Timed out waiting for PDF download");
}

// Try every known way to trigger the official PDF download in the viewer.
async function triggerDownload(page) {
  // 1) Direct download button in toolbar
  const selectors = [
    "#dl_btn",
    "a#dl_btn",
    'a[href*="/dv/report/"][href*="pdf"]',
    'a[href*="download"][href*="pdf"]',
    'a[title*="Download" i]',
    'a[aria-label*="Download" i]',
    'button[title*="Download" i]',
  ];
  for (const sel of selectors) {
    const el = await page.$(sel);
    if (el) {
      await el.click().catch(() => {});
      return true;
    }
  }

  // 2) Print menu -> "Current View" / "Download PDF"
  const printBtn = await page.$('#print_btn, a[title*="Print" i], button[title*="Print" i]');
  if (printBtn) {
    await printBtn.click().catch(() => {});
    await sleep(800);
    const menuItem = await page.$(
      'a[href*="pdf"], a[onclick*="pdf" i], li:has(a):has-text("Download"), a:has-text("Current View")',
    );
    if (menuItem) {
      await menuItem.click().catch(() => {});
      return true;
    }
  }

  return false;
}

// ---- routes ----

app.get("/health", (_req, res) => res.send("ok"));

app.post("/report-pdf", auth, async (req, res) => {
  const { viewUrl } = req.body || {};
  if (!viewUrl || typeof viewUrl !== "string" || !viewUrl.startsWith("http")) {
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
        "--no-zygote",
      ],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 1000 });

    // Force downloads to our temp dir via CDP
    const client = await page.target().createCDPSession();
    await client.send("Page.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: downloadDir,
    });
    await client.send("Browser.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: downloadDir,
      eventsEnabled: true,
    }).catch(() => {});

    // Load the viewer
    await page.goto(viewUrl, { waitUntil: "networkidle2", timeout: 60_000 });

    // The viewer often loads its toolbar inside an iframe — give it a moment
    await sleep(2500);

    // Try clicking the download in the main page first
    let clicked = await triggerDownload(page);

    // Then try every frame (the toolbar is commonly inside #dv_frame)
    if (!clicked) {
      for (const frame of page.frames()) {
        try {
          const ok = await triggerDownload(frame);
          if (ok) {
            clicked = true;
            break;
          }
        } catch {}
      }
    }

    if (!clicked) throw new Error("Could not find download button in iThenticate viewer");

    // Wait for the real PDF to land on disk
    const pdfPath = await waitForPdf(downloadDir, 90_000);
    const buf = fs.readFileSync(pdfPath);

    // sanity check: %PDF
    if (!(buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46)) {
      throw new Error("Downloaded file is not a PDF");
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Length", buf.length);
    res.setHeader("Content-Disposition", 'attachment; filename="similarity-report.pdf"');
    return res.end(buf); // raw bytes — NOT res.json(buf)
  } catch (err) {
    console.error("[report-pdf]", err);
    return res.status(500).json({ error: String(err?.message || err) });
  } finally {
    try { await browser?.close(); } catch {}
    try { fs.rmSync(downloadDir, { recursive: true, force: true }); } catch {}
  }
});

app.listen(PORT, () => console.log(`Proxy listening on :${PORT}`));
