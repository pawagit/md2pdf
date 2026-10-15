#!/usr/bin/env node

/**
 * md2pdf — Markdown to PDF converter
 *
 * Usage:
 *   node convert.js <file.md> [file2.md ...]
 *   Drag one or more .md files onto convert.bat
 *
 * Output: PDF saved next to each input file (e.g. README.md → README.pdf)
 * Fenced ```mermaid blocks are rendered as vector diagrams.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const { Marked } = require("marked");
const { gfmHeadingId } = require("marked-gfm-heading-id");
const puppeteer = require("puppeteer-core");

// Mermaid's "tiny" build: one self-contained file, no further dependencies.
// It is loaded into the page only when a document contains a ```mermaid fence.
const MERMAID_JS = require.resolve("@mermaid-js/tiny");

// Paper size. Margins come from config.json (per theme).
const PAGE_FORMAT = "A4"; // or "Letter"
const PAGE_SIZES = { A4: ["210mm", "297mm"], Letter: ["8.5in", "11in"] };
const PX_PER_UNIT = { px: 1, mm: 96 / 25.4, cm: 96 / 2.54, in: 96, pt: 96 / 72 };

function toPx(length) {
  const m = /^\s*([\d.]+)\s*(px|mm|cm|in|pt)\s*$/i.exec(String(length));
  return m ? Number(m[1]) * PX_PER_UNIT[m[2].toLowerCase()] : 0;
}

// Printable area in CSS px — tells renderDiagrams() how tall a page is
function printableArea(margin) {
  const [w, h] = PAGE_SIZES[PAGE_FORMAT];
  return {
    width: toPx(w) - toPx(margin.left) - toPx(margin.right),
    height: toPx(h) - toPx(margin.top) - toPx(margin.bottom),
  };
}

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

  // marked emits ```mermaid fences as <pre><code class="language-mermaid">;
  // renderDiagrams() (2d) turns them into SVG inside the browser. The script
  // is only included when needed — it costs ~0.5 s to load.
  const mermaidTag = body.includes('class="language-mermaid"')
    ? `\n  <script src="${pathToFileURL(MERMAID_JS).href}"></script>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <base href="${baseHref}">
  <title>${escapeHtml(title)}</title>
  <style>${cssContent}</style>${mermaidTag}
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
// 2d. Render Mermaid diagrams — runs INSIDE the browser via page.evaluate()
// ---------------------------------------------------------------------------
// Replaces every <pre><code class="language-mermaid"> with the rendered SVG.
// Colours and fonts are read from the style.css tokens, so diagrams follow
// the active theme. A diagram that fails to parse keeps its source block
// (class "mermaid-error", message in data-error) and is reported back.
// `printable` is the page's printable area in CSS px ({ width, height }).
// A diagram taller than that is cut into page-sized pieces, because Chrome
// cannot paginate one SVG that is taller than a page: it spills onto the
// next page and then leaves a blank of the same height on the page after.
// Keep this function self-contained (no Node globals) and in sync with the
// copy in docs/index.html.
async function renderDiagrams(printable = null, doc = document, mermaid = window.mermaid) {
  const blocks = [...doc.querySelectorAll("pre > code.language-mermaid")];
  const result = { count: blocks.length, errors: [], split: [] };
  if (!blocks.length || !mermaid) return result;

  const css = doc.defaultView.getComputedStyle(doc.body);
  const token = (name) => css.getPropertyValue(name).trim();
  mermaid.initialize({
    startOnLoad: false,
    suppressErrorRendering: true, // no "bomb" graphic — we keep the source instead
    theme: "base",
    themeVariables: {
      fontFamily: css.fontFamily,
      fontSize: css.fontSize, // follows the theme (compact / comfortable)
      primaryColor: token("--code-bg"),
      primaryBorderColor: token("--accent"),
      primaryTextColor: token("--ink-strong"),
      lineColor: token("--ink-soft"),
      secondaryColor: token("--surface"),
      tertiaryColor: token("--surface-alt"),
      clusterBkg: token("--surface-alt"),
      clusterBorder: token("--border"),
      edgeLabelBackground: "#ffffff",
    },
  });
  await doc.fonts.ready;

  for (const [i, code] of blocks.entries()) {
    const pre = code.parentElement;
    try {
      const { svg } = await mermaid.render(`md2pdf-diagram-${i}`, code.textContent);
      const figure = doc.createElement("figure");
      figure.className = "mermaid";
      figure.innerHTML = svg;
      pre.replaceWith(figure);
      const pages = printable ? splitTallDiagram(figure.firstElementChild, printable) : 1;
      if (pages > 1) {
        figure.classList.add("split");
        result.split.push({ index: i + 1, pages });
      }
    } catch (e) {
      // First line only ("Parse error on line 4"); the rest lists every expected token
      const message = String((e && e.message) || e).split("\n")[0].replace(/:\s*$/, "");
      pre.classList.add("mermaid-error");
      pre.dataset.error = message; // shown as a caption by style.css
      result.errors.push({ index: i + 1, message });
    }
  }
  return result;

  // Cuts an SVG taller than the printable page into consecutive viewBox
  // windows, one <svg> each. A piece is at most 85 % of a page so the first
  // one can share its page with the heading above it. Each cut is moved up,
  // by up to 40 % of a piece, to the nearest line that crosses no node or
  // label. Returns the number of pieces.
  function splitTallDiagram(svg, page) {
    const vb = (svg.getAttribute("viewBox") || "").split(/[\s,]+/).map(Number);
    if (vb.length !== 4 || !(vb[3] > 0)) return 1;
    const [x, top, width, height] = vb;
    const scale = Math.min(1, page.width / width); // printed px per SVG unit
    if (height * scale <= page.height) return 1;
    const pieceH = (page.height * 0.85) / scale;

    // Boxes a cut should not pass through: anything small enough to be a
    // node or a label (subgraph frames and long edges are left out)
    const root = svg.getBoundingClientRect();
    const k = root.height / height; // screen px per SVG unit
    const boxes = k > 0
      ? [...svg.querySelectorAll("rect, polygon, circle, ellipse, path, foreignObject, text")]
          .map((el) => {
            const r = el.getBoundingClientRect();
            return { top: top + (r.top - root.top) / k, bottom: top + (r.bottom - root.top) / k };
          })
          .filter((b) => b.bottom > b.top && b.bottom - b.top < pieceH / 2)
      : [];
    const clear = (y) => !boxes.some((b) => b.top < y - 1 && b.bottom > y + 1);

    const edges = [top];
    let y = top;
    while (top + height - y > pieceH) {
      let cut = y + pieceH;
      for (let c = cut; c > y + pieceH * 0.6; c -= 1) {
        if (clear(c)) { cut = c; break; }
      }
      edges.push(cut);
      y = cut;
    }
    edges.push(top + height);

    const pieces = edges.slice(1).map((_, i) => (i === 0 ? svg : svg.cloneNode(true)));
    pieces.forEach((piece, i) => {
      piece.setAttribute("viewBox", `${x} ${edges[i]} ${width} ${edges[i + 1] - edges[i]}`);
      piece.removeAttribute("height"); // height follows the viewBox (CSS height: auto)
      if (i > 0) svg.parentNode.appendChild(piece);
    });
    return pieces.length;
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

    // Diagrams: a failure is a warning, not a failed file — the PDF still
    // ships, with the diagram's source and the error message in place.
    const { errors, split } = await page.evaluate(renderDiagrams, printableArea(margin));
    for (const { index, message } of errors) {
      console.log(`  ⚠️  Diagram ${index} not rendered — ${message} (source kept in the PDF)`);
    }
    for (const { index, pages } of split) {
      console.log(`  📐 Diagram ${index} is taller than a page — split into ${pages} parts`);
    }

    await page.pdf({
      path: outPath,
      format: PAGE_FORMAT,
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
