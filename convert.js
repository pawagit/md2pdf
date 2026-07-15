#!/usr/bin/env node

/**
 * md2pdf — Markdown to PDF converter
 *
 * Usage:
 *   node convert.js <file.md> [file2.md ...]
 *   Drag one or more .md files onto convert.bat
 *
 * Output: PDF saved next to each input file (e.g. README.md → README.pdf)
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const { Marked } = require("marked");
const { gfmHeadingId } = require("marked-gfm-heading-id");
const puppeteer = require("puppeteer-core");

// ---------------------------------------------------------------------------
// 1. Locate Chrome / Edge on Windows (no admin install needed)
// ---------------------------------------------------------------------------
function findBrowser() {
  const candidates = [
    // Chrome
    process.env["PROGRAMFILES"] &&
      path.join(process.env["PROGRAMFILES"], "Google/Chrome/Application/chrome.exe"),
    process.env["PROGRAMFILES(X86)"] &&
      path.join(process.env["PROGRAMFILES(X86)"], "Google/Chrome/Application/chrome.exe"),
    process.env["LOCALAPPDATA"] &&
      path.join(process.env["LOCALAPPDATA"], "Google/Chrome/Application/chrome.exe"),
    // Edge (available on virtually every managed Windows machine)
    process.env["PROGRAMFILES(X86)"] &&
      path.join(process.env["PROGRAMFILES(X86)"], "Microsoft/Edge/Application/msedge.exe"),
    process.env["PROGRAMFILES"] &&
      path.join(process.env["PROGRAMFILES"], "Microsoft/Edge/Application/msedge.exe"),
  ].filter(Boolean);

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 2a. Load config.json (theme selection + per-theme page margins)
// ---------------------------------------------------------------------------
function loadConfig() {
  const defaults = {
    theme: "compact",
    footer: { timestamp: "none" },
    themes: {
      comfortable: { margin: { top: "20mm", right: "20mm", bottom: "20mm", left: "20mm" } },
      compact: { margin: { top: "14mm", right: "16mm", bottom: "14mm", left: "16mm" } },
    },
  };

  const configPath = path.join(__dirname, "config.json");
  if (!fs.existsSync(configPath)) return defaults;

  try {
    // Strip a UTF-8 BOM if present (Notepad and friends add one) — JSON.parse rejects it
    const user = JSON.parse(fs.readFileSync(configPath, "utf-8").replace(/^\uFEFF/, ""));
    return {
      theme: user.theme || defaults.theme,
      footer: { ...defaults.footer, ...(user.footer || {}) },
      themes: { ...defaults.themes, ...(user.themes || {}) },
    };
  } catch (e) {
    console.warn(`⚠️  Could not read config.json (${e.message}); using defaults.`);
    return defaults;
  }
}

// ---------------------------------------------------------------------------
// 2b. Build a full HTML document from Markdown + CSS
// ---------------------------------------------------------------------------
function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildHtml(markdownContent, cssContent, title, theme, baseHref) {
  const marked = new Marked();
  marked.use(gfmHeadingId());

  const body = marked.parse(markdownContent);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <base href="${baseHref}">
  <title>${escapeHtml(title)}</title>
  <style>${cssContent}</style>
</head>
<body class="${theme}">
  <article class="markdown-body">
    ${body}
  </article>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// 2c. Footer timestamp (config.json → footer.timestamp)
// ---------------------------------------------------------------------------
function formatTimestamp(date) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
}

function footerLabel(mode, modifiedAt) {
  switch (mode) {
    case "modified":
      return `Last saved ${formatTimestamp(modifiedAt)}`;
    case "generated":
      return `Generated ${formatTimestamp(new Date())}`;
    case "both":
      return `Saved ${formatTimestamp(modifiedAt)} · PDF ${formatTimestamp(new Date())}`;
    default:
      return "";
  }
}

// ---------------------------------------------------------------------------
// 3. Convert one .md file to .pdf
// ---------------------------------------------------------------------------
async function convertFile(mdPath, browser, css, theme, margin, timestampMode) {
  const absPath = path.resolve(mdPath);
  const parsed = path.parse(absPath);
  const outPath = path.join(parsed.dir, parsed.name + ".pdf");
  const title = parsed.name;

  console.log(`  📄 ${path.basename(mdPath)}`);

  const stamp = footerLabel(timestampMode, fs.statSync(absPath).mtime);
  const md = fs.readFileSync(absPath, "utf-8");
  // <base href> makes relative image paths resolve against the source folder
  const baseHref = pathToFileURL(parsed.dir + path.sep).href;
  const html = buildHtml(md, css, title, theme, baseHref);

  // Load via a temp file:// document (not setContent) so Chrome is allowed
  // to read local images referenced in the Markdown.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "md2pdf-"));
  const tmpHtml = path.join(tmpDir, "doc.html");
  fs.writeFileSync(tmpHtml, html);

  const page = await browser.newPage();
  try {
    await page.goto(pathToFileURL(tmpHtml).href, { waitUntil: "networkidle0" });

    await page.pdf({
      path: outPath,
      format: "A4",
      printBackground: true,
      margin,
      displayHeaderFooter: true,
      headerTemplate: "<span></span>",
      footerTemplate: `
      <div style="width:100%; font-size:9px; color:#999; display:flex; padding:0 ${margin.right} 0 ${margin.left};">
        <span style="flex:1 1 0; text-align:left;">${stamp}</span>
        <span style="white-space:nowrap;"><span class="pageNumber"></span> / <span class="totalPages"></span></span>
        <span style="flex:1 1 0;"></span>
      </div>`,
    });
  } finally {
    await page.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  console.log(`  ✅ → ${path.basename(outPath)}`);
}

// ---------------------------------------------------------------------------
// 4. Main
// ---------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log("Usage: node convert.js <file.md> [file2.md ...]");
    console.log("   or: drag .md files onto convert.bat");
    process.exit(1);
  }

  // Load custom CSS (fall back to embedded minimal style)
  const cssPath = path.join(__dirname, "style.css");
  const css = fs.existsSync(cssPath)
    ? fs.readFileSync(cssPath, "utf-8")
    : "body { font-family: sans-serif; max-width: 800px; margin: auto; }";

  // Resolve theme + page margins from config.json
  const config = loadConfig();
  let theme = config.theme;
  if (!config.themes[theme]) {
    console.warn(`⚠️  Unknown theme "${theme}"; falling back to "comfortable".`);
    theme = "comfortable";
  }
  const margin = config.themes[theme].margin;
  console.log(`🎨 Theme: ${theme}`);

  // Resolve footer timestamp mode from config.json
  let timestampMode = config.footer.timestamp || "none";
  if (!["modified", "generated", "both", "none"].includes(timestampMode)) {
    console.warn(`⚠️  Unknown footer.timestamp "${timestampMode}"; using "none".`);
    timestampMode = "none";
  }
  if (timestampMode !== "none") console.log(`🕒 Footer timestamp: ${timestampMode}`);

  // Find browser
  const executablePath = findBrowser();
  if (!executablePath) {
    console.error("❌ Could not find Chrome or Edge. Please install one of them.");
    process.exit(1);
  }
  console.log(`🌐 Using: ${path.basename(executablePath)}`);

  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ["--no-sandbox", "--disable-gpu"],
  });

  console.log("Converting…\n");

  let failed = 0;
  try {
    for (const file of args) {
      if (!/\.(md|markdown|mdown)$/i.test(file)) {
        console.log(`  ⏭  Skipping non-Markdown file: ${file}`);
        continue;
      }
      if (!fs.existsSync(file)) {
        console.log(`  ⚠️  File not found: ${file}`);
        failed++;
        continue;
      }
      try {
        await convertFile(file, browser, css, theme, margin, timestampMode);
      } catch (err) {
        failed++;
        const outName = path.parse(file).name + ".pdf";
        if (err.code === "EBUSY" || err.code === "EPERM") {
          console.log(`  ❌ Could not write ${outName} — close it in your PDF viewer and try again.`);
        } else {
          console.log(`  ❌ ${path.basename(file)}: ${err.message}`);
        }
      }
    }
  } finally {
    await browser.close();
  }

  if (failed > 0) {
    console.log(`\nDone, but ${failed} file${failed === 1 ? "" : "s"} failed. ⚠️`);
    process.exit(1);
  }
  console.log("\nDone! 🎉");
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
