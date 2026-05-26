import express from 'express';
import puppeteer from 'puppeteer';

const {
  PORT = 8080,
  API_KEY,
  ITHENTICATE_USERNAME,
  ITHENTICATE_PASSWORD,
  ITHENTICATE_BASE_URL = 'https://www.ithenticate.com',
  NAV_TIMEOUT_MS = 60000,
  RENDER_WAIT_MS = 8000,
} = process.env;

if (!API_KEY || !ITHENTICATE_USERNAME || !ITHENTICATE_PASSWORD) {
  console.error('Missing required env vars: API_KEY, ITHENTICATE_USERNAME, ITHENTICATE_PASSWORD');
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '256kb' }));

// ---- Auth middleware (simple shared API key) ----
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  const provided = req.header('x-api-key');
  if (!provided || provided !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

app.get('/health', (_req, res) => res.json({ ok: true }));

// ---- Browser singleton ----
let browserPromise = null;
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
        '--single-process',
      ],
    });
  }
  return browserPromise;
}

async function loginAndGetCookies(page) {
  await page.goto(`${ITHENTICATE_BASE_URL}/en_us/login`, {
    waitUntil: 'networkidle2',
    timeout: Number(NAV_TIMEOUT_MS),
  });

  // iThenticate login form (email + password)
  await page.waitForSelector('input[name="email"]', { timeout: 30000 });
  await page.type('input[name="email"]', ITHENTICATE_USERNAME, { delay: 20 });
  await page.type('input[name="password"]', ITHENTICATE_PASSWORD, { delay: 20 });

  await Promise.all([
    page.click('button[type="submit"], input[type="submit"]'),
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: Number(NAV_TIMEOUT_MS) }),
  ]);

  const url = page.url();
  if (/login/i.test(url)) {
    throw new Error('Login failed: still on login page. Check credentials.');
  }
}

/**
 * POST /report-pdf
 * Body: { viewUrl?: string, documentId?: string }
 *
 * - If `viewUrl` is provided (the iThenticate view_only_url from your XML-RPC
 *   report.get response), the bot opens it directly. This is the recommended path.
 * - If only `documentId` is provided, the bot navigates to the document inside
 *   the authenticated session.
 *
 * Returns: application/pdf stream
 */
app.post('/report-pdf', async (req, res) => {
  const { viewUrl, documentId } = req.body || {};
  if (!viewUrl && !documentId) {
    return res.status(400).json({ error: 'Provide viewUrl or documentId' });
  }

  let page;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 1800, deviceScaleFactor: 1 });

    // The view_only_url already embeds an auth token, but logging in first
    // makes the session more reliable across redirects.
    await loginAndGetCookies(page);

    const targetUrl = viewUrl
      ? viewUrl
      : `${ITHENTICATE_BASE_URL}/en_us/dv?o=${encodeURIComponent(documentId)}`;

    await page.goto(targetUrl, {
      waitUntil: 'networkidle2',
      timeout: Number(NAV_TIMEOUT_MS),
    });

    // The similarity viewer is a JS-heavy SPA — give it time to fully render.
    await new Promise((r) => setTimeout(r, Number(RENDER_WAIT_MS)));

    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '12mm', right: '10mm', bottom: '12mm', left: '10mm' },
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="similarity-report.pdf"');
    res.setHeader('Cache-Control', 'no-store');
    res.end(pdf);
  } catch (err) {
    console.error('report-pdf error:', err);
    res.status(500).json({ error: err.message || 'Failed to generate PDF' });
  } finally {
    if (page) await page.close().catch(() => {});
  }
});

app.listen(PORT, () => {
  console.log(`iThenticate PDF proxy listening on :${PORT}`);
});

// Graceful shutdown
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    try {
      const b = await browserPromise;
      if (b) await b.close();
    } catch {}
    process.exit(0);
  });
}
