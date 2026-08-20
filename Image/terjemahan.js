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
    // area subtitle lama di video (untuk di-blur), biarkan default kalau video
    // punya hardsub bahasa asli yang mau ditutup
    x: 0,
    y: 645,
    w: 576,
    h: 135,
    sigma: 15,        // kekuatan blur subtitle lama
    fontsize: 12,      // ukuran font subtitle baru
    blur: true,        // set --blur=false kalau video tidak punya hardsub lama
    srcLang: "zh",     // bahasa audio asli (kode whisper, mis. zh, en, ja)
    tgtLang: "id",     // bahasa target terjemahan (kode Google Translate)
    whisperBin: "whisper-cli", // nama/path binary whisper.cpp
    model: "",         // WAJIB diisi: path ke file model ggml whisper.cpp (mis. models/ggml-small.bin)
  };

  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [key, value] = arg.slice(2).split("=");
    if (
      key === "input" || key === "output" || key === "srcLang" ||
      key === "tgtLang" || key === "whisperBin" || key === "model"
    ) {
      args[key] = value;
    } else if (key === "blur") {
      args[key] = value !== "false" && value !== "0";
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

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

// ---------- Tahap 1: ekstrak audio ----------

async function extractAudio(inputPath, audioPath) {
  await run("ffmpeg", [
    "-y",
    "-i", inputPath,
    "-vn",
    "-ac", "1",
    "-ar", "16000",
    "-acodec", "pcm_s16le",
    audioPath,
  ]);
}

// ---------- Tahap 2: speech-to-text pakai whisper.cpp ----------

async function transcribe(audioPath, tmpDir, opts) {
  const outPrefix = path.join(tmpDir, "transcript");
  await run(opts.whisperBin, [
    "-m", opts.model,
    "-f", audioPath,
    "-l", opts.srcLang,
    "-osrt",
    "-of", outPrefix,
    "-nt", // tanpa timestamp di stdout, kita baca dari file .srt saja
  ]);
  const srtPath = `${outPrefix}.srt`;
  if (!fs.existsSync(srtPath)) {
    throw new Error(`whisper.cpp tidak menghasilkan file .srt di ${srtPath}`);
  }
  return parseSrt(fs.readFileSync(srtPath, "utf-8"));
}

function srtTimeToSeconds(t) {
  const [h, m, rest] = t.split(":");
  const [s, ms] = rest.split(",");
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
}

function parseSrt(content) {
  const blocks = content.split(/\r?\n\r?\n/).map((b) => b.trim()).filter(Boolean);
  const segments = [];
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    const timeLine = lines.find((l) => l.includes("-->"));
    if (!timeLine) continue;
    const [startStr, endStr] = timeLine.split("-->").map((s) => s.trim());
    const text = lines.slice(lines.indexOf(timeLine) + 1).join(" ").trim();
    if (!text) continue;
    segments.push({
      start: srtTimeToSeconds(startStr),
      end: srtTimeToSeconds(endStr),
      text,
    });
  }
  return segments;
}

// ---------- Tahap 3: terjemahan pakai Google Translate (endpoint publik) ----------

async function googleTranslate(text, srcLang, tgtLang) {
  const url =
    `https://translate.googleapis.com/translate_a/single?client=gtx` +
    `&sl=${encodeURIComponent(srcLang)}&tl=${encodeURIComponent(tgtLang)}` +
    `&dt=t&q=${encodeURIComponent(text)}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Google Translate gagal (HTTP ${res.status})`);
  }
  const data = await res.json();
  // data[0] = array of [translatedChunk, originalChunk, ...]
  return data[0].map((chunk) => chunk[0]).join("").trim();
}

async function translateSegments(segments, opts) {
  const translated = [];
  for (const seg of segments) {
    let text = seg.text;
    try {
      text = await googleTranslate(seg.text, opts.srcLang, opts.tgtLang);
    } catch (err) {
      console.error(`  ! Gagal menerjemahkan segmen "${seg.text.slice(0, 30)}...": ${err.message}`);
    }
    translated.push({ start: seg.start, end: seg.end, text });
    await sleep(150); // jeda kecil supaya tidak kena rate-limit endpoint publik
  }
  return translated;
}

// ---------- Tahap 4: format SRT ----------

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

// ---------- Tahap 5: render ulang video (blur lama opsional + subtitle baru) ----------

async function renderVideo(inputPath, srtPath, outputPath, opts) {
  // Jalankan ffmpeg dengan cwd = folder tempat .srt berada, lalu rujuk .srt
  // hanya dengan nama filenya saja. Ini menghindari masalah escaping path
  // (terutama drive letter "C:" di Windows yang bentrok dengan syntax
  // filter ffmpeg yang juga memakai ':').
  const srtDir = path.dirname(path.resolve(srtPath));
  const srtFileName = path.basename(srtPath);
  const absInput = path.resolve(inputPath);
  const absOutput = path.resolve(outputPath);

  const subtitleStyle =
    `subtitles=${srtFileName}:force_style=` +
    `'FontName=Arial Bold,FontSize=${opts.fontsize},PrimaryColour=&H00FFFFFF,` +
    `OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=0,Alignment=2,MarginV=60'`;

  const filterComplex = opts.blur
    ? `[0:v]crop=${opts.w}:${opts.h}:${opts.x}:${opts.y},gblur=sigma=${opts.sigma}[b];` +
      `[0:v][b]overlay=${opts.x}:${opts.y}[blurred];` +
      `[blurred]${subtitleStyle}[out]`
    : `[0:v]${subtitleStyle}[out]`;

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
  const audioPath = path.join(tmpDir, "audio.wav");

  try {
    console.log("  - Ekstrak audio...");
    await extractAudio(inputPath, audioPath);

    console.log("  - Transkripsi (whisper.cpp)...");
    const rawSegments = await transcribe(audioPath, tmpDir, opts);

    if (rawSegments.length === 0) {
      console.log("  - Tidak ada ucapan terdeteksi, video dilewati.");
      return;
    }

    console.log(`  - Menerjemahkan ${rawSegments.length} baris (Google Translate)...`);
    const segments = await translateSegments(rawSegments, opts);

    const srtPath = path.join(outputDir, `${baseName}.srt`);
    fs.writeFileSync(srtPath, segmentsToSrt(segments), "utf-8");
    console.log(`  - SRT tersimpan: ${srtPath} (${segments.length} baris)`);

    const outVideoPath = path.join(outputDir, `${baseName}${path.extname(inputPath)}`);
    console.log("  - Render ulang video (blur lama opsional + subtitle baru)...");
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

async function checkDependencies(opts) {
  const ffmpegOk = await checkDependency("ffmpeg", ["-version"],
    "Install dulu: sudo apt install ffmpeg (Ubuntu/Debian) atau brew install ffmpeg (macOS)."
  );
  const whisperOk = await checkDependency(opts.whisperBin, ["--help"],
    "Compile whisper.cpp dulu: git clone https://github.com/ggml-org/whisper.cpp lalu ikuti " +
    "instruksi build di README-nya, atau set --whisperBin=/path/ke/binary."
  );

  let modelOk = true;
  if (!opts.model || !fs.existsSync(opts.model)) {
    console.error(
      `File model whisper.cpp tidak ditemukan: "${opts.model}". ` +
      `Download model ggml-nya dulu (mis. lewat models/download-ggml-model.sh di repo whisper.cpp) ` +
      `lalu isi --model=path/ke/ggml-model.bin`
    );
    modelOk = false;
  }

  return ffmpegOk && whisperOk && modelOk;
}

// ---------- Main ----------

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const depsOk = await checkDependencies(opts);
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

  console.log(`Ditemukan ${files.length} video di ${inputDir}`);
  console.log(`Bahasa: ${opts.srcLang} -> ${opts.tgtLang}\n`);

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