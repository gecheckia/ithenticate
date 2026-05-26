import express from "express";
import puppeteer from "puppeteer";
import { createClient } from "@supabase/supabase-js";

const PORT = process.env.PORT || 10000;
const API_KEY = process.env.PROXY_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing env vars: PROXY_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/", (_req, res) => res.send("ok"));
app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/start-job", (req, res) => {
  if (req.headers["x-api-key"] !== API_KEY) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const { viewUrl, bucket, storagePath } = req.body || {};
  if (!viewUrl || !bucket || !storagePath) {
    return res.status(400).json({ error: "missing fields" });
  }

  // Respond immediately, render in background
  res.status(202).json({ accepted: true });

  renderAndUpload({ viewUrl, bucket, storagePath }).catch((err) => {
    console.error("[job failed]", storagePath, err);
  });
});

async function renderAndUpload({ viewUrl, bucket, storagePath }) {
  console.log("[job start]", storagePath);
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1800 });
    await page.goto(viewUrl, { waitUntil: "networkidle2", timeout: 120_000 });
    // Give the iThenticate viewer a moment to fully paint
    await new Promise((r) => setTimeout(r, 4000));

    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "12mm", bottom: "12mm", left: "10mm", right: "10mm" },
    });

    const { error } = await supabase.storage
      .from(bucket)
      .upload(storagePath, pdf, {
        contentType: "application/pdf",
        upsert: true,
      });

    if (error) throw error;
    console.log("[job done]", storagePath);
  } finally {
    await browser.close().catch(() => {});
  }
}

app.listen(PORT, () => {
  console.log(`PDF proxy listening on :${PORT}`);
});
