const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const VIDEO_EXTENSIONS = [".mp4", ".mov", ".mkv", ".avi", ".webm"];

// ---------- Argumen ----------

function parseArgs(argv) {
  const args = {
    input: "./input",
    output: "./output",
    x: 0,
    y: 645,
    w: 576,
    h: 135,
    fps: 5,       // berapa frame per detik yang diambil untuk OCR
    sigma: 15,    // kekuatan blur subtitle asli
    fontsize: 15, // ukuran font subtitle baru
    lang: "ind",  // bahasa OCR (pastikan tesseract-ocr-ind sudah terinstall)
  };

  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [key, value] = arg.slice(2).split("=");
    if (key === "input" || key === "output" || key === "lang") {
      args[key] = value;
    } else if (key in args) {
      args[key] = Number(value);
    }
  }

  return args;
}

// ---------- Helper proses eksternal ----------

function run(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, options);
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d) => (stdout += d.toString()));
    proc.stderr?.on("data", (d) => (stderr += d.toString()));
    proc.on("error", (err) =>
      reject(new Error(`Gagal menjalankan ${cmd}: ${err.message}`))
    );
    proc.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} keluar dengan kode ${code}\n${stderr}`));
    });
  });
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function getVideoFiles(dir) {
  return fs
    .readdirSync(dir)
    .filter((f) => VIDEO_EXTENSIONS.includes(path.extname(f).toLowerCase()))
    .sort();
}

// ---------- Tahap 1: ekstrak & threshold frame area subtitle ----------

async function extractFrames(inputPath, framesDir, opts) {
  ensureDir(framesDir);
  // crop area subtitle lalu ambil N frame per detik
  await run("ffmpeg", [
    "-y",
    "-i", inputPath,
    "-vf", `fps=${opts.fps},crop=${opts.w}:${opts.h}:${opts.x}:${opts.y}`,
    path.join(framesDir, "f_%04d.png"),
  ]);
}

// Threshold sederhana pakai ffmpeg (tanpa dependency image processing tambahan):
// ubah ke grayscale lalu terapkan curves supaya piksel terang (teks putih)
// jadi hitam di atas latar putih -> lebih gampang dibaca tesseract.
async function thresholdFrames(framesDir, binDir) {
  ensureDir(binDir);
  const files = fs.readdirSync(framesDir).filter((f) => f.endsWith(".png"));
  for (const file of files) {
    await run("ffmpeg", [
      "-y",
      "-i", path.join(framesDir, file),
      "-vf", "format=gray,geq=lum='if(gt(lum(X,Y),200),0,255)'",
      path.join(binDir, file),
    ]);
  }
}

// ---------- Tahap 2: OCR tiap frame ----------

async function ocrFrames(binDir, lang) {
  const files = fs.readdirSync(binDir).filter((f) => f.endsWith(".png")).sort();
  const results = [];
  for (const file of files) {
    const idx = Number(file.match(/(\d+)/)[1]);
    const { stdout } = await run("tesseract", [
      path.join(binDir, file),
      "-",
      "-l", lang,
      "--psm", "6",
    ]);
    const text = stdout.replace(/\s+/g, " ").trim();
    results.push({ index: idx, text });
  }
  return results;
}

// ---------- Tahap 3: kelompokkan hasil OCR jadi baris subtitle ----------

function cleanText(text) {
  return text
    .replace(/[^A-Za-z0-9À-ÿ.,!?'\-\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalize(text) {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// similarity ratio sederhana ala difflib (Levenshtein-based)
function similarity(a, b) {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const dist = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  return maxLen === 0 ? 1 : 1 - dist / maxLen;
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

const WORD_RE = /^[A-Za-zÀ-ÿ'\-]{2,}[.,!?]?$/;

function wordScore(text) {
  const words = text.split(" ").filter(Boolean);
  const valid = words.filter((w) => WORD_RE.test(w)).length;
  return { valid, total: words.length };
}

function trimToValidPrefix(text) {
  const words = text.split(" ").filter(Boolean);
  const out = [];
  for (const w of words) {
    if (WORD_RE.test(w)) out.push(w);
    else break;
  }
  return out.join(" ");
}

function pickBest(candidates) {
  const counts = {};
  for (const c of candidates) counts[c] = (counts[c] || 0) + 1;

  let best = null;
  for (const [text, cnt] of Object.entries(counts)) {
    const { valid, total } = wordScore(text);
    if (total === 0) continue;
    const ratio = valid / total;
    const score = { ratio, valid, cnt, negLen: -text.length, text };
    if (
      !best ||
      score.ratio > best.ratio ||
      (score.ratio === best.ratio && score.valid > best.valid) ||
      (score.ratio === best.ratio && score.valid === best.valid && score.cnt > best.cnt) ||
      (score.ratio === best.ratio && score.valid === best.valid && score.cnt === best.cnt && score.negLen > best.negLen)
    ) {
      best = score;
    }
  }
  return best ? best.text : null;
}

function groupIntoSegments(ocrResults, fps) {
  const frameDt = 1 / fps;
  const rows = ocrResults
    .sort((a, b) => a.index - b.index)
    .map((r) => ({
      t: (r.index - 1) * frameDt,
      text: cleanText(r.text),
    }));

  const SIM_THRESHOLD = 0.55;
  const MAX_GAP = 1;

  const segments = [];
  let cur = [];
  let gap = 0;
  let rep = null;

  function closeSegment() {
    if (cur.length === 0) return;
    const start = cur[0].t;
    const end = cur[cur.length - 1].t + frameDt;
    const best = pickBest(cur.map((c) => c.text));
    if (best && end - start >= 0.3) {
      const trimmed = trimToValidPrefix(best);
      if (trimmed) {
        const { total } = wordScore(trimmed);
        if (total >= 1 && trimmed.length >= 4 && (total >= 2 || trimmed.length >= 6)) {
          segments.push({ start, end, text: trimmed });
        }
      }
    }
    cur = [];
  }

  for (const { t, text } of rows) {
    if (!text) {
      if (cur.length) {
        gap++;
        if (gap > MAX_GAP) {
          closeSegment();
          rep = null;
          gap = 0;
        }
      }
      continue;
    }
    gap = 0;
    const n = normalize(text);
    if (!cur.length) {
      cur = [{ t, text }];
      rep = n;
    } else {
      const sim = similarity(n, rep);
      if (sim >= SIM_THRESHOLD) {
        cur.push({ t, text });
        if (n.length > rep.length) rep = n;
      } else {
        closeSegment();
        cur = [{ t, text }];
        rep = n;
      }
    }
  }
  closeSegment();

  return segments;
}

function formatTime(t) {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const ms = Math.round((t - Math.floor(t)) * 1000);
  const pad = (n, l = 2) => String(n).padStart(l, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

function segmentsToSrt(segments) {
  return segments
    .map(
      (seg, i) =>
        `${i + 1}\n${formatTime(seg.start)} --> ${formatTime(seg.end)}\n${seg.text}\n`
    )
    .join("\n");
}

// ---------- Tahap 4: render ulang video (blur lama + subtitle baru) ----------

async function renderVideo(inputPath, srtPath, outputPath, opts) {
  const filterComplex =
    `[0:v]crop=${opts.w}:${opts.h}:${opts.x}:${opts.y},gblur=sigma=${opts.sigma}[b];` +
    `[0:v][b]overlay=${opts.x}:${opts.y}[blurred];` +
    `[blurred]subtitles=${escapeForFilter(srtPath)}:force_style=` +
    `'FontName=Arial Bold,FontSize=${opts.fontsize},PrimaryColour=&H00FFFFFF,` +
    `OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=0,Alignment=2,MarginV=60'[out]`;

  await run("ffmpeg", [
    "-y",
    "-i", inputPath,
    "-filter_complex", filterComplex,
    "-map", "[out]",
    "-map", "0:a?",
    "-c:v", "libx264",
    "-crf", "18",
    "-preset", "medium",
    "-c:a", "copy",
    outputPath,
  ]);
}

function escapeForFilter(p) {
  // ffmpeg filter path perlu escape karakter khusus seperti ':' dan '\'
  return p.replace(/\\/g, "/").replace(/:/g, "\\:");
}

// ---------- Orkestrasi per file ----------

async function processVideo(inputPath, outputDir, opts) {
  const baseName = path.basename(inputPath, path.extname(inputPath));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "subocr-"));
  const framesDir = path.join(tmpDir, "frames");
  const binDir = path.join(tmpDir, "frames_bin");

  try {
    console.log("  - Ekstrak frame subtitle...");
    await extractFrames(inputPath, framesDir, opts);

    console.log("  - Threshold frame untuk OCR...");
    await thresholdFrames(framesDir, binDir);

    console.log("  - Menjalankan OCR (bisa agak lama)...");
    const ocrResults = await ocrFrames(binDir, opts.lang);

    console.log("  - Menyusun baris subtitle...");
    const segments = groupIntoSegments(ocrResults, opts.fps);

    if (segments.length === 0) {
      console.log("  - Tidak ada subtitle terdeteksi, video dilewati.");
      return;
    }

    const srtPath = path.join(outputDir, `${baseName}.srt`);
    fs.writeFileSync(srtPath, segmentsToSrt(segments), "utf-8");
    console.log(`  - SRT tersimpan: ${srtPath} (${segments.length} baris)`);

    const outVideoPath = path.join(outputDir, `${baseName}${path.extname(inputPath)}`);
    console.log("  - Render ulang video (blur lama + subtitle baru)...");
    await renderVideo(inputPath, srtPath, outVideoPath, opts);
    console.log(`  - Video tersimpan: ${outVideoPath}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---------- Main ----------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const inputDir = path.resolve(opts.input);
  const outputDir = path.resolve(opts.output);

  if (!fs.existsSync(inputDir)) {
    console.error(`Folder input tidak ditemukan: ${inputDir}`);
    process.exit(1);
  }
  ensureDir(outputDir);

  const files = getVideoFiles(inputDir);
  if (files.length === 0) {
    console.log(`Tidak ada file video di ${inputDir}`);
    return;
  }

  console.log(`Ditemukan ${files.length} video di ${inputDir}\n`);

  let success = 0;
  let failed = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    console.log(`[${i + 1}/${files.length}] Memproses: ${file}`);
    try {
      await processVideo(path.join(inputDir, file), outputDir, opts);
      success++;
    } catch (err) {
      console.error(`  -> Gagal: ${err.message}`);
      failed++;
    }
    console.log("");
  }

  console.log(`Selesai semua. Berhasil: ${success}, Gagal: ${failed}`);
}

main();