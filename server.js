import express from "express";
import puppeteer from "puppeteer";

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;

if (!API_KEY) {
  console.error("Missing API_KEY env var");
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/report-pdf", async (req, res) => {
  if (req.header("x-api-key") !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { viewUrl } = req.body || {};
  if (typeof viewUrl !== "string" || !/^https?:\/\//.test(viewUrl)) {
    return res.status(400).json({ error: "viewUrl is required" });
  }

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
    await page.setViewport({ width: 1280, height: 1800, deviceScaleFactor: 1 });

    // view_only_url already embeds an auth token; no login required.
    await page.goto(viewUrl, { waitUntil: "networkidle2", timeout: 90_000 });

    // Give the SPA viewer time to render highlights/similarity panels.
    await new Promise((r) => setTimeout(r, 10_000));

    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "12mm", right: "10mm", bottom: "12mm", left: "10mm" },
    });

    res
      .status(200)
      .setHeader("Content-Type", "application/pdf")
      .setHeader(
        "Content-Disposition",
        'attachment; filename="similarity-report.pdf"',
      )
      .send(pdf);
  } catch (e) {
    console.error("[report-pdf]", e);
    res.status(500).json({ error: String(e?.message || e) });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

const server = app.listen(PORT, () => console.log(`listening on :${PORT}`));

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
