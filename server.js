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

// ---------- auth ----------
function auth(req, res, next) {
  if (!API_KEY) {
    console.error("[proxy] PROXY_API_KEY not set");
    return res.status(500).json({ error: "PROXY_API_KEY not set" });
  }
  const key = req.header("x-api-key");
  if (key !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ---------- helpers ----------
async function login(page) {
  await page.goto("https://app.ithenticate.com/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  // Detect the username field across iThenticate's variants
  const userHandle = await page.waitForSelector(
    [
      'input[type="email"]',
      'input[name="email"]',
      'input[name="login"]',
      'input[name="username"]',
      'input#username',
      'input#email',
      'input#login',
    ].join(","),
    { timeout: 45000 }
  );

  const passHandle = await page.waitForSelector('input[type="password"]', {
    timeout: 30000,
  });

  await userHandle.click({ clickCount: 3 });
  await userHandle.type(ITH_USER, { delay: 20 });
  await passHandle.click({ clickCount: 3 });
  await passHandle.type(ITH_PASS, { delay: 20 });

  await Promise.all([
    page
      .waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 })
      .catch(() => {}),
    (async () => {
      const submit = await page.$(
        'button[type="submit"], input[type="submit"], button[name="login"], #login_button'
      );
      if (submit) await submit.click();
      else await page.keyboard.press("Enter");
    })(),
  ]);
}

async function getViewerContexts(page) {
  // Returns the main page + every frame, so we can search the print button
  // wherever it lives (often inside a same-origin iframe).
  const frames = page.frames();
  return [page, ...frames.filter((f) => f !== page.mainFrame())];
}

async function triggerDownload(page) {
  const selectors = [
    '#print_btn',
    'a#print_btn',
    'a[title*="Print" i]',
    'button[title*="Print" i]',
    'a[aria-label*="Print" i]',
    'button[aria-label*="Print" i]',
    'a[href*="print"]',
    '.print-btn',
    '.printer',
    'i.icon-print',
    'i.fa-print',
    'span.icon-print',
    '[data-action="print"]',
  ];

  const ctxs = await getViewerContexts(page);

  for (const ctx of ctxs) {
    for (const sel of selectors) {
      try {
        const el = await ctx.$(sel);
        if (!el) continue;
        // Click via JS to avoid surface/visibility issues
        await ctx.evaluate((node) => {
          const target = node.closest("a") || node;
          target.click();
        }, el);
        return true;
      } catch {}
    }
  }

  // Last resort: search by visible text
  for (const ctx of ctxs) {
    try {
      const clicked = await ctx.evaluate(() => {
        const all = Array.from(document.querySelectorAll("a,button,span,i"));
        const cand = all.find((e) => {
          const t = (e.textContent || "").trim().toLowerCase();
          const tl = (e.getAttribute("title") || "").toLowerCase();
          const al = (e.getAttribute("aria-label") || "").toLowerCase();
          return (
            t === "print" ||
            tl.includes("print") ||
            al.includes("print") ||
            (e.className || "").toString().toLowerCase().includes("print")
          );
        });
        if (cand) {
          (cand.closest("a") || cand).click();
          return true;
        }
        return false;
      });
      if (clicked) return true;
    } catch {}
  }

  return false;
}

async function waitForPdf(dir, timeoutMs = 90000) {
  const start = Date.now();
  let lastSize = -1;
  let stableSince = 0;

  while (Date.now() - start < timeoutMs) {
    const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    const pdfs = files.filter(
      (f) => f.toLowerCase().endsWith(".pdf") && !f.endsWith(".crdownload")
    );

    if (pdfs.length > 0) {
      const full = path.join(dir, pdfs[0]);
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

  throw new Error("Timed out waiting for PDF download");
}

// ---------- routes ----------
app.get("/health", (_req, res) => {
  res.json({ ok: true, hasApiKey: !!API_KEY });
});

app.post("/report-pdf", auth, async (req, res) => {
  const { viewUrl } = req.body || {};
  if (!viewUrl || typeof viewUrl !== "string" || !viewUrl.startsWith("http")) {
    return res.status(400).json({ error: "Missing or invalid viewUrl" });
  }
  if (!ITH_USER || !ITH_PASS) {
    return res
      .status(500)
      .json({ error: "ITHENTICATE_USERNAME / ITHENTICATE_PASSWORD not set" });
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
        "--disable-gpu",
      ],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 1000 });

    const client = await page.target().createCDPSession();
    await client.send("Page.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: downloadDir,
    });

    // 1) Login
    await login(page);

    // 2) Open the report viewer
    await page.goto(viewUrl, { waitUntil: "networkidle2", timeout: 90000 });
    await new Promise((r) => setTimeout(r, RENDER_WAIT_MS));

    // 3) Click the printer icon (auto-downloads the PDF)
    const clicked = await triggerDownload(page);
    if (!clicked) {
      const snippet = (await page.content()).slice(0, 2000);
      console.error("[proxy] page snippet:", snippet);
      return res
        .status(500)
        .json({ error: "Could not find download/print button in iThenticate viewer" });
    }

    // 4) Wait for the PDF file to land in downloadDir
    const pdfPath = await waitForPdf(downloadDir, 120000);
    const buf = fs.readFileSync(pdfPath);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="ithenticate-report.pdf"`
    );
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
