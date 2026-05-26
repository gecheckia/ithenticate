// server.js
import express from "express";
import puppeteer from "puppeteer";

const PORT = process.env.PORT || 8080;
const API_KEY = process.env.PROXY_API_KEY || process.env.API_KEY;
const ITH_USER = process.env.ITHENTICATE_USERNAME;
const ITH_PASS = process.env.ITHENTICATE_PASSWORD;
const RENDER_WAIT_MS = parseInt(process.env.RENDER_WAIT_MS || "8000", 10);

const app = express();
app.use(express.json({ limit: "2mb" }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    hasApiKey: !!API_KEY,
    hasIthCreds: !!(ITH_USER && ITH_PASS),
  });
});

async function launchBrowser() {
  return puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--single-process",
      "--window-size=1400,1000",
    ],
    defaultViewport: { width: 1400, height: 1000 },
  });
}

async function login(page) {
  await page.goto("https://app.ithenticate.com/en_us/login", {
    waitUntil: "networkidle2",
    timeout: 60000,
  });

  const SELECTORS =
    'input[type="email"], input[name="email"], input[name="login"], input[name="username"], input#username, input#email, input#login';

  const findField = async () => {
    if (await page.$(SELECTORS)) return { frame: page, sel: SELECTORS };
    for (const f of page.frames()) {
      try {
        if (await f.$(SELECTORS)) return { frame: f, sel: SELECTORS };
      } catch {}
    }
    return null;
  };

  let target = null;
  for (let i = 0; i < 30 && !target; i++) {
    target = await findField();
    if (!target) await sleep(1000);
  }
  if (!target) {
    const html = await page.content();
    console.error("[proxy] login HTML head:", html.slice(0, 1500));
    throw new Error("No se encontró el formulario de login");
  }

  await target.frame.type(target.sel, ITH_USER, { delay: 20 });
  await target.frame.type('input[type="password"], input[name="password"]', ITH_PASS, { delay: 20 });

  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 }).catch(() => {}),
    target.frame
      .click('button[type="submit"], input[type="submit"]')
      .catch(() => page.keyboard.press("Enter")),
  ]);
}

async function tryClickDownload(page) {
  const SELECTORS = [
    'a[title*="Download" i]',
    'button[title*="Download" i]',
    'a[aria-label*="Download" i]',
    'button[aria-label*="Download" i]',
    'a[href*="download"]',
    'a[href*=".pdf"]',
    '.download',
    '#download',
    '[data-test*="download" i]',
  ];

  const tryIn = async (ctx) => {
    for (const s of SELECTORS) {
      const el = await ctx.$(s).catch(() => null);
      if (el) {
        await el.click().catch(() => {});
        return true;
      }
    }
    // text fallback
    const handle = await ctx
      .evaluateHandle(() => {
        const all = Array.from(document.querySelectorAll("a,button"));
        return all.find((e) => /download/i.test(e.textContent || "")) || null;
      })
      .catch(() => null);
    if (handle) {
      const el = handle.asElement?.();
      if (el) {
        await el.click().catch(() => {});
        return true;
      }
    }
    return false;
  };

  if (await tryIn(page)) return true;
  for (const f of page.frames()) {
    if (await tryIn(f)) return true;
  }
  return false;
}

app.post("/report-pdf", async (req, res) => {
  try {
    if (!API_KEY) return res.status(500).json({ error: "PROXY_API_KEY not set" });
    if (req.headers["x-api-key"] !== API_KEY)
      return res.status(401).json({ error: "Unauthorized" });
    if (!ITH_USER || !ITH_PASS)
      return res.status(500).json({ error: "ITHENTICATE_USERNAME/PASSWORD not set" });

    const { viewUrl, mode } = req.body || {};
    if (!viewUrl || typeof viewUrl !== "string")
      return res.status(400).json({ error: "viewUrl required" });

    const browser = await launchBrowser();
    try {
      const page = await browser.newPage();
      await page.setUserAgent(
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      );

      // Intercept any PDF response that comes through.
      let pdfBuffer = null;
      page.on("response", async (resp) => {
        try {
          const ct = (resp.headers()["content-type"] || "").toLowerCase();
          const url = resp.url();
          if (ct.includes("application/pdf") || /\.pdf(\?|$)/i.test(url)) {
            const buf = await resp.buffer().catch(() => null);
            if (buf && buf.length > 200 && buf.slice(0, 4).toString() === "%PDF") {
              pdfBuffer = buf;
            }
          }
        } catch {}
      });

      await login(page);
      await page.goto(viewUrl, { waitUntil: "networkidle2", timeout: 90000 });
      await sleep(RENDER_WAIT_MS);

      if (mode === "official") {
        await tryClickDownload(page);
        const deadline = Date.now() + 90000;
        while (!pdfBuffer && Date.now() < deadline) {
          await sleep(500);
        }
      }

      // Fallback: render viewer to PDF
      if (!pdfBuffer) {
        console.warn("[proxy] no official PDF intercepted, falling back to page.pdf()");
        pdfBuffer = await page.pdf({
          format: "A4",
          printBackground: true,
          margin: { top: "10mm", bottom: "10mm", left: "10mm", right: "10mm" },
        });
      }

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Length", pdfBuffer.length);
      res.end(pdfBuffer);
    } finally {
      await browser.close().catch(() => {});
    }
  } catch (e) {
    console.error("[proxy] error", e);
    res.status(500).json({ error: e?.message || "proxy error" });
  }
});

app.listen(PORT, () => console.log(`[proxy] listening on ${PORT}`));
