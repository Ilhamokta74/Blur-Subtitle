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
    y: 600,
    w: 576,
    h: 200,
    fps: 15,       // berapa frame per detik yang diambil untuk OCR
    sigma: 15,    // kekuatan blur subtitle asli
    fontsize: 11, // ukuran font subtitle baru
    lang: "ind",  // bahasa OCR (pastikan tesseract-ocr-ind sudah terinstall)
    scale: 3,      // faktor upscale sebelum OCR (huruf kecil -> OCR jelek)
    threshold: 200, // ambang luma untuk binarisasi (turunkan kalau subtitle kuning/redup)
    minConf: 40,   // buang kata hasil OCR dengan confidence < nilai ini (0-100)
    psm: 6,        // 6 = blok teks (multi-baris), 7 = satu baris saja
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

// Threshold pakai ffmpeg (tanpa dependency image processing tambahan):
// ubah ke grayscale, UPSCALE (huruf kecil = musuh utama akurasi Tesseract),
// sharpen dikit supaya tepi huruf tegas lagi setelah discale, baru threshold
// supaya piksel terang (teks putih) jadi hitam di atas latar putih.
//
// Diproses sebagai satu image-sequence (bukan loop spawn per file) - jauh
// lebih cepat untuk video dengan ratusan/ribuan frame.
async function thresholdFrames(framesDir, binDir, opts = {}) {
  ensureDir(binDir);
  const files = fs.readdirSync(framesDir).filter((f) => f.endsWith(".png"));
  if (files.length === 0) return;

  const scale = opts.scale ?? 3;
  const thr = opts.threshold ?? 200;

  await run("ffmpeg", [
    "-y",
    "-i", path.join(framesDir, "f_%04d.png"),
    "-vf",
    `format=gray,scale=iw*${scale}:ih*${scale}:flags=lanczos,` +
    `unsharp=5:5:1.0,` +
    `median=radius=1,` +
    `geq=lum='if(gt(lum(X,Y),${thr}),0,255)'`,
    path.join(binDir, "f_%04d.png"),
  ]);
}

// ---------- Tahap 2: OCR tiap frame ----------

// Parse output TSV Tesseract (`tesseract ... tsv`) dan buang kata dengan
// confidence di bawah minConf. Ini penting karena noise sisa threshold
// (bercak, artefak upscale, dll) biasanya menghasilkan "kata" acak dengan
// confidence rendah - kalau ikut divoting di pickBest(), bisa mengalahkan
// hasil bacaan yang benar tapi kurang sering muncul persis sama.
function tsvToText(tsv, minConf) {
  const lines = tsv.split("\n").slice(1); // baris pertama = header
  const words = [];
  for (const line of lines) {
    const cols = line.split("\t");
    if (cols.length < 12) continue;
    const conf = Number(cols[10]);
    const text = cols[11];
    if (!text || !text.trim()) continue;
    if (Number.isFinite(conf) && conf < minConf) continue;
    words.push(text.trim());
  }
  return words.join(" ");
}

async function ocrFrames(binDir, opts) {
  const files = fs.readdirSync(binDir).filter((f) => f.endsWith(".png")).sort();
  const results = [];
  for (const file of files) {
    const idx = Number(file.match(/(\d+)/)[1]);
    const { stdout } = await run("tesseract", [
      path.join(binDir, file),
      "-",
      "-l", opts.lang,
      "--psm", String(opts.psm ?? 6),
      "--oem", "1",       // paksa pakai LSTM engine (lebih akurat dari legacy)
      "--dpi", "300",     // frame sudah discale, kasih tau dpi biar LSTM konsisten
      "-c", "tessedit_do_invert=0", // jangan auto-invert, kita sudah binarisasi manual
      "tsv",
    ]);
    const text = tsvToText(stdout, opts.minConf ?? 40);
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

const WORD_RE = /^(?:[A-Za-zÀ-ÿ'\-]{2,}[.,!?]?|[0-9]+[.,!?]?)$/;

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

// Buang kata yang berulang persis di posisi berurutan ("gaji gaji" -> "gaji").
// Ini artefak umum dari konsensus per-kata / batas antar frame OCR, bukan
// pengulangan asli dari pembicara.
function collapseDuplicateWords(text) {
  const words = text.split(" ").filter(Boolean);
  const out = [];
  for (const w of words) {
    if (out.length === 0 || out[out.length - 1].toLowerCase() !== w.toLowerCase()) {
      out.push(w);
    }
  }
  return out.join(" ");
}

// Konsensus per-kata: kelompokkan kandidat berdasarkan jumlah kata (OCR yang
// bagus biasanya sepakat soal jumlah kata walau isi katanya kadang beda tipis),
// lalu untuk tiap posisi kata, ambil versi yang paling sering muncul di posisi
// itu. Ini menangkap kasus di mana tidak ada satupun string yang identik persis
// sesering itu, tapi mayoritas kata per-posisi sebenarnya konsisten benar.
//
// `support` = jumlah kandidat yang dipakai untuk membangun konsensus ini -
// dipakai sebagai bobot suara pengganti "cnt", supaya hasil konsensus tidak
// kalah cuma gara-gara tidak ada satupun string identik yang sering.
function pickBestConsensus(candidates) {
  const byLen = {};
  for (const c of candidates) {
    const words = c.split(" ").filter(Boolean);
    if (words.length === 0) continue;
    (byLen[words.length] ??= []).push(words);
  }

  let bestLen = null;
  let bestCount = -1;
  for (const [len, groups] of Object.entries(byLen)) {
    if (groups.length > bestCount) {
      bestCount = groups.length;
      bestLen = len;
    }
  }
  if (bestLen === null) return null;

  const groups = byLen[bestLen];
  const wordCount = Number(bestLen);
  const consensus = [];
  for (let i = 0; i < wordCount; i++) {
    const counts = {};
    for (const g of groups) counts[g[i]] = (counts[g[i]] || 0) + 1;
    let bestWord = null;
    let bestWordCount = -1;
    for (const [w, c] of Object.entries(counts)) {
      if (c > bestWordCount) {
        bestWordCount = c;
        bestWord = w;
      }
    }
    consensus.push(bestWord);
  }
  return { text: consensus.join(" "), support: groups.length };
}

function pickBest(candidates) {
  const counts = {};
  for (const c of candidates) counts[c] = (counts[c] || 0) + 1;

  // Konsensus per-kata ikut bersaing lewat scoring yang sama di bawah, dengan
  // bobot suara ("cnt") = jumlah kandidat yang menyumbang ke konsensus ini -
  // biasanya lebih tinggi dari cnt exact-match manapun, jadi ini menang kalau
  // memang mayoritas kata sepakat walau tidak ada string yang identik persis.
  const consensus = pickBestConsensus(candidates);
  if (consensus) {
    counts[consensus.text] = Math.max(counts[consensus.text] || 0, consensus.support);
  }

  let best = null;
  for (const [text, cnt] of Object.entries(counts)) {
    const { valid, total } = wordScore(text);
    if (total === 0) continue;
    const ratio = valid / total;
    const score = { ratio, cnt, valid, negLen: -text.length, text };
    if (
      !best ||
      score.ratio > best.ratio ||
      (score.ratio === best.ratio && score.cnt > best.cnt) ||
      (score.ratio === best.ratio && score.cnt === best.cnt && score.valid > best.valid) ||
      (score.ratio === best.ratio && score.cnt === best.cnt && score.valid === best.valid && score.negLen > best.negLen)
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
      const trimmed = collapseDuplicateWords(trimToValidPrefix(best));
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
  // Jalankan ffmpeg dengan cwd = folder tempat .srt berada, lalu rujuk .srt
  // hanya dengan nama filenya saja. Ini menghindari masalah escaping path
  // (terutama drive letter "C:" di Windows yang bentrok dengan syntax
  // filter ffmpeg yang juga memakai ':').
  const srtDir = path.dirname(path.resolve(srtPath));
  const srtFileName = path.basename(srtPath);
  const absInput = path.resolve(inputPath);
  const absOutput = path.resolve(outputPath);

  const filterComplex =
    `[0:v]crop=${opts.w}:${opts.h}:${opts.x}:${opts.y},gblur=sigma=${opts.sigma}[b];` +
    `[0:v][b]overlay=${opts.x}:${opts.y}[blurred];` +
    `[blurred]subtitles=${srtFileName}:force_style=` +
    `'FontName=Arial Bold,FontSize=${opts.fontsize},PrimaryColour=&H00FFFFFF,` +
    `OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=0,Alignment=2,MarginV=60'[out]`;

  await run("ffmpeg", [
    "-y",
    "-i", absInput,
    "-filter_complex", filterComplex,
    "-map", "[out]",
    "-map", "0:a?",
    "-c:v", "libx264",
    "-crf", "18",
    "-preset", "medium",
    "-c:a", "copy",
    absOutput,
  ], { cwd: srtDir });
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
    await thresholdFrames(framesDir, binDir, opts);

    console.log("  - Menjalankan OCR (bisa agak lama)...");
    const ocrResults = await ocrFrames(binDir, opts);

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

// ---------- Cek dependency sebelum mulai ----------

async function checkDependency(cmd, versionArgs, installHint) {
  try {
    await run(cmd, versionArgs);
    return true;
  } catch (err) {
    console.error(`Tidak bisa menjalankan "${cmd}". ${installHint}`);
    return false;
  }
}

async function checkDependencies(lang) {
  const ffmpegOk = await checkDependency("ffmpeg", ["-version"],
    "Install dulu: sudo apt install ffmpeg (Ubuntu/Debian) atau brew install ffmpeg (macOS)."
  );
  const tesseractOk = await checkDependency("tesseract", ["--version"],
    "Install dulu: sudo apt install tesseract-ocr tesseract-ocr-ind (Ubuntu/Debian) atau brew install tesseract tesseract-lang (macOS)."
  );

  if (tesseractOk) {
    try {
      const { stdout } = await run("tesseract", ["--list-langs"]);
      if (!stdout.includes(lang)) {
        console.error(
          `Paket bahasa "${lang}" belum terinstall untuk tesseract. ` +
          `Install dulu: sudo apt install tesseract-ocr-${lang} (Ubuntu/Debian).`
        );
        return false;
      }
    } catch (err) {
      // abaikan, sudah ditangani di checkDependency di atas
    }
  }

  return ffmpegOk && tesseractOk;
}

// ---------- Main ----------

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const depsOk = await checkDependencies(opts.lang);
  if (!depsOk) {
    console.error("\nSetup belum lengkap. Perbaiki hal di atas dulu sebelum menjalankan script ini.");
    process.exit(1);
  }

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