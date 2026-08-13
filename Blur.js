const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const VIDEO_EXTENSIONS = [".mp4", ".mov", ".mkv", ".avi", ".webm"];

function parseArgs(argv) {
  const args = {
    input: "./input",
    output: "./output",
    x: 0,
    y: 645,
    w: 576,
    h: 135,
    sigma: 15,
  };

  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [key, value] = arg.slice(2).split("=");
    if (key === "input" || key === "output") {
      args[key] = value;
    } else if (key in args) {
      args[key] = Number(value);
    }
  }

  return args;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`Membuat folder: ${dir}`);
  }
}

function getVideoFiles(dir) {
  return fs
    .readdirSync(dir)
    .filter((file) => VIDEO_EXTENSIONS.includes(path.extname(file).toLowerCase()))
    .sort();
}

function blurSubtitle({ input, output, x, y, w, h, sigma }) {
  return new Promise((resolve, reject) => {
    const filterComplex =
      `[0:v]crop=${w}:${h}:${x}:${y},gblur=sigma=${sigma}[blurred];` +
      `[0:v][blurred]overlay=${x}:${y}[out]`;

    const ffmpegArgs = [
      "-y",
      "-i", input,
      "-filter_complex", filterComplex,
      "-map", "[out]",
      "-map", "0:a?",
      "-c:v", "libx264",
      "-crf", "18",
      "-preset", "medium",
      "-c:a", "copy",
      output,
    ];

    const ffmpeg = spawn("ffmpeg", ffmpegArgs);

    ffmpeg.stderr.on("data", () => {
      // diamkan log detail ffmpeg supaya output batch bersih
      // hapus baris ini kalau mau lihat progress penuh
    });

    ffmpeg.on("error", (err) => {
      reject(new Error(`Gagal menjalankan ffmpeg: ${err.message}. Pastikan ffmpeg sudah terinstall.`));
    });

    ffmpeg.on("close", (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`ffmpeg keluar dengan kode error ${code}`));
    });
  });
}

async function run() {
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
    const inputPath = path.join(inputDir, file);
    const outputPath = path.join(outputDir, file);

    console.log(`[${i + 1}/${files.length}] Memproses: ${file} ...`);

    try {
      await blurSubtitle({
        input: inputPath,
        output: outputPath,
        x: opts.x,
        y: opts.y,
        w: opts.w,
        h: opts.h,
        sigma: opts.sigma,
      });
      console.log(`  -> Selesai: ${outputPath}\n`);
      success++;
    } catch (err) {
      console.error(`  -> Gagal: ${err.message}\n`);
      failed++;
    }
  }

  console.log(`Selesai semua. Berhasil: ${success}, Gagal: ${failed}`);
}

run();