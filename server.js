import express from "express";
import puppeteer from "puppeteer";
import { createClient } from "@supabase/supabase-js";

const PORT = process.env.PORT || 10000;
const PROXY_API_KEY = process.env.PROXY_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!PROXY_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing required env vars: PROXY_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "ithenticate-pdf-proxy" });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/start-job", async (req, res) => {
  const apiKey = req.header("x-api-key");
  if (apiKey !== PROXY_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { viewUrl, bucket, storagePath } = req.body || {};
  if (!viewUrl || !bucket || !storagePath) {
    return res.status(400).json({ error: "Missing viewUrl, bucket, or storagePath" });
  }

  res.status(202).json({ ok: true, accepted: true });

  renderAndUpload({ viewUrl, bucket, storagePath }).catch((err) => {
    console.error("[renderAndUpload] failed:", err);
  });
});

async function renderAndUpload({ viewUrl, bucket, storagePath }) {
  console.log(`[job] start ${storagePath}`);
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1800 });

    await page.goto(viewUrl, { waitUntil: "networkidle2", timeout: 120000 });
    await new Promise((r) => setTimeout(r, 120000));

    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "10mm", bottom: "10mm", left: "10mm", right: "10mm" },
    });

    const { error: uploadError } = await supabase.storage
      .from(bucket)
      .upload(storagePath, pdf, {
        contentType: "application/pdf",
        upsert: true,
      });

    if (uploadError) {
      console.error("[job] upload error:", uploadError);
      return;
    }

    console.log(`[job] done ${storagePath}`);
  } catch (err) {
    console.error("[job] error:", err);
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }
  }
}

app.listen(PORT, () => {
  console.log(`ithenticate-pdf-proxy listening on :${PORT}`);
});
