const express = require("express");
const puppeteer = require("puppeteer");

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.PROXY_API_KEY;
const ITH_USER = process.env.ITHENTICATE_USERNAME;
const ITH_PASS = process.env.ITHENTICATE_PASSWORD;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RENDER_WAIT_MS = parseInt(process.env.RENDER_WAIT_MS || "8000", 10);

if (!API_KEY || !ITH_USER || !ITH_PASS || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("[proxy] missing env vars");
  process.exit(1);
}

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/start-job", (req, res) => {
  if (req.header("x-api-key") !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const { viewUrl, bucket, storagePath } = req.body || {};
  if (!viewUrl || !bucket || !storagePath) {
    return res.status(400).json({ error: "Missing fields" });
  }
  res.status(202).json({ accepted: true, storagePath });
  processJob({ viewUrl, bucket, storagePath }).catch((e) => {
    console.error("[proxy] job failed", storagePath, e && e.message ? e.message : e);
  });
});

async function processJob({ viewUrl, bucket, storagePath }) {
  console.log("[proxy] start job", storagePath);
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });

  let pdfBuffer = null;
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 1800 });

    page.on("response", async (response) => {
      try {
        const ct = response.headers()["content-type"] || "";
        if (ct.indexOf("application/pdf") !== -1) {
          const buf = await response.buffer();
          if (buf.length > 200 && buf[0] === 0x25 && buf[1] === 0x50) {
            pdfBuffer = buf;
            console.log("[proxy] captured pdf", buf.length, "bytes");
          }
        }
      } catch (_) {}
    });

    await page.goto(viewUrl, { waitUntil: "networkidle2", timeout: 60000 });

    const needsLogin = await page.evaluate(() => {
      return !!document.querySelector('input[type="email"], input[name="email"], input[name="login"], input[name="username"]');
    });

    if (needsLogin) {
      console.log("[proxy] login required");
      const emailSel = 'input[type="email"], input[name="email"], input[name="login"], input[name="username"]';
      await page.waitForSelector(emailSel, { timeout: 30000 });
      await page.type(emailSel, ITH_USER, { delay: 20 });
      await page.type('input[type="password"], input[name="password"]', ITH_PASS, { delay: 20 });
      await Promise.all([
        page.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 }).catch(() => {}),
        page.click('button[type="submit"], input[type="submit"]'),
      ]);
      console.log("[proxy] login submitted");
    }

    await new Promise((r) => setTimeout(r, RENDER_WAIT_MS));

    const clickInFrame = async (frame) => {
      const selectors = [
        'a[title*="Download" i]',
        'button[title*="Download" i]',
        'a[aria-label*="Download" i]',
        'button[aria-label*="Download" i]',
        'a[href*="download"]',
        '#download-button',
        '.download-icon',
        'a.download',
        'button.download',
      ];
      for (let i = 0; i < selectors.length; i++) {
        const el = await frame.$(selectors[i]);
        if (el) {
          await el.click().catch(() => {});
          console.log("[proxy] clicked", selectors[i]);
          return true;
        }
      }
      const clicked = await frame.evaluate(() => {
        const all = Array.from(document.querySelectorAll("a, button"));
        const target = all.find((el) =>
          /download/i.test(el.textContent || "") ||
          /download/i.test(el.getAttribute("title") || "") ||
          /download/i.test(el.getAttribute("aria-label") || "")
        );
        if (target) { target.click(); return true; }
        return false;
      });
      if (clicked) console.log("[proxy] clicked via text fallback");
      return clicked;
    };

    let clicked = await clickInFrame(page);
    if (!clicked) {
      const frames = page.frames();
      for (let i = 0; i < frames.length; i++) {
        clicked = await clickInFrame(frames[i]);
        if (clicked) break;
      }
    }

    const deadline = Date.now() + 90000;
    while (!pdfBuffer && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
    }

    if (!pdfBuffer) throw new Error("Official PDF not captured within 90s");
  } finally {
    await browser.close().catch(() => {});
  }

  const uploadUrl = SUPABASE_URL + "/storage/v1/object/" + bucket + "/" + storagePath;
  const upRes = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + SUPABASE_SERVICE_KEY,
      "Content-Type": "application/pdf",
      "x-upsert": "true",
    },
    body: pdfBuffer,
  });
  if (!upRes.ok) {
    const txt = await upRes.text().catch(() => "");
    throw new Error("Supabase upload failed " + upRes.status + ": " + txt.slice(0, 300));
  }
  console.log("[proxy] uploaded", storagePath, pdfBuffer.length, "bytes");
}

app.listen(PORT, () => console.log("[proxy] listening on " + PORT));
