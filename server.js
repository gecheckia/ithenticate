// server.js — handler /report-pdf (reemplaza el actual)
const path = require("path");
const fs = require("fs/promises");
const os = require("os");

app.post("/report-pdf", async (req, res) => {
  if (req.headers["x-api-key"] !== process.env.PROXY_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const { viewUrl } = req.body || {};
  if (!viewUrl || !/^https?:\/\//.test(viewUrl)) {
    return res.status(400).json({ error: "Invalid viewUrl" });
  }

  const downloadDir = await fs.mkdtemp(path.join(os.tmpdir(), "ith-"));
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const page = await browser.newPage();

    // Tell Chromium where to save downloads
    const client = await page.target().createCDPSession();
    await client.send("Page.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: downloadDir,
    });

    await page.goto(viewUrl, { waitUntil: "networkidle2", timeout: 90000 });

    // The viewer loads the report inside an iframe. Wait for the download
    // button (printer icon, id="dl_btn") inside that frame.
    await page.waitForTimeout(4000); // give viewer JS time to mount

    let clicked = false;
    for (const frame of page.frames()) {
      try {
        const btn = await frame.$(
          '#dl_btn, a[title*="Descargar"], a[title*="Download"], button[title*="Download"]'
        );
        if (btn) {
          await btn.click();
          clicked = true;
          break;
        }
      } catch (_) {}
    }
    if (!clicked) throw new Error("Download button not found in viewer");

    // iThenticate may open a small dialog asking for "Current view" vs
    // "Digital receipt". Pick "Current view" (the actual report PDF).
    await page.waitForTimeout(1500);
    for (const frame of page.frames()) {
      const opt = await frame.$('a:has-text("Current View"), a:has-text("Vista actual")');
      if (opt) { await opt.click(); break; }
    }

    // Wait for the .pdf file to appear and stop growing
    const pdfPath = await waitForPdf(downloadDir, 90000);
    const buf = await fs.readFile(pdfPath);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Length", buf.length);
    return res.end(buf); // raw binary, NOT JSON
  } catch (err) {
    console.error("[report-pdf] failed:", err);
    return res
      .status(500)
      .json({ error: String(err && err.message ? err.message : err) });
  } finally {
    if (browser) await browser.close().catch(() => {});
    fs.rm(downloadDir, { recursive: true, force: true }).catch(() => {});
  }
});

async function waitForPdf(dir, timeoutMs) {
  const start = Date.now();
  let lastSize = -1, stableSince = 0;
  while (Date.now() - start < timeoutMs) {
    const files = (await fs.readdir(dir)).filter(f => f.toLowerCase().endsWith(".pdf"));
    if (files.length) {
      const full = path.join(dir, files[0]);
      const st = await fs.stat(full);
      if (st.size > 1024 && st.size === lastSize) {
        if (Date.now() - stableSince > 1500) return full;
      } else {
        lastSize = st.size;
        stableSince = Date.now();
      }
    }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error("Timeout waiting for PDF download");
}
