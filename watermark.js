const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const sharp = require('sharp');

// ========================= KONFIGURASI ========================= //
const CONFIG = {
  position: 'top-right', // top-left | top-right | bottom-left | bottom-right | center
  scale: 0.15,               // lebar watermark relatif terhadap lebar gambar/video (0-1)
  opacity: 0.5,               // transparansi watermark (0-1)
  margin: 10,                  // jarak watermark dari tepi (px)
};

const INPUT_DIR = path.join(__dirname, 'input');
const OUTPUT_DIR = path.join(__dirname, 'output');
const WATERMARK_PATH = path.join(__dirname, 'image', 'watermark.png');
// ================================================================= //

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.tiff', '.avif', '.gif'];
const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.mkv', '.avi', '.webm', '.flv', '.m4v', '.wmv'];

function checkFfmpeg() {
  return new Promise((resolve) => {
    const p = spawn('ffmpeg', ['-version']);
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
  });
}

// Ambil durasi video (detik) lewat ffprobe, untuk hitung persentase progress
function getVideoDuration(inputPath) {
  return new Promise((resolve) => {
    const p = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      inputPath,
    ]);
    let out = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.on('close', () => {
      const duration = parseFloat(out.trim());
      resolve(Number.isFinite(duration) ? duration : 0);
    });
    p.on('error', () => resolve(0));
  });
}

// Ubah "00:00:12.34" (format time= dari ffmpeg) menjadi detik
function timeStringToSeconds(str) {
  const parts = str.split(':').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return 0;
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

// Render progress bar teks, mis: [██████░░░░] 62%
function renderProgressBar(percent, width = 24) {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  return `[${bar}] ${clamped.toFixed(0)}%`;
}

function findMediaFiles(dir, list = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      findMediaFiles(fullPath, list);
    } else {
      const ext = path.extname(entry.name).toLowerCase();
      if (IMAGE_EXTENSIONS.includes(ext)) list.push({ path: fullPath, type: 'image' });
      else if (VIDEO_EXTENSIONS.includes(ext)) list.push({ path: fullPath, type: 'video' });
    }
  }
  return list;
}

// ---------- Watermark untuk GAMBAR (pakai sharp) ---------- //

async function applyOpacity(buffer, opacity) {
  if (opacity >= 1) return buffer;
  const img = sharp(buffer).ensureAlpha();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  for (let i = 3; i < data.length; i += 4) {
    data[i] = Math.round(data[i] * opacity);
  }
  return sharp(data, {
    raw: { width: info.width, height: info.height, channels: info.channels },
  })
    .png()
    .toBuffer();
}

function calculatePosition(position, imgW, imgH, wmW, wmH, margin) {
  switch (position) {
    case 'top-left':
      return { left: margin, top: margin };
    case 'top-right':
      return { left: imgW - wmW - margin, top: margin };
    case 'bottom-left':
      return { left: margin, top: imgH - wmH - margin };
    case 'bottom-right':
      return { left: imgW - wmW - margin, top: imgH - wmH - margin };
    case 'center':
      return { left: Math.round((imgW - wmW) / 2), top: Math.round((imgH - wmH) / 2) };
    default:
      return { left: margin, top: margin };
  }
}

async function processImage(inputPath, outputPath) {
  const baseImage = sharp(inputPath);
  const baseMeta = await baseImage.metadata();
  const imgW = baseMeta.width;
  const imgH = baseMeta.height;

  const wmTargetWidth = Math.round(imgW * CONFIG.scale);
  let wmBuffer = await sharp(WATERMARK_PATH).resize({ width: wmTargetWidth }).png().toBuffer();
  wmBuffer = await applyOpacity(wmBuffer, CONFIG.opacity);
  const wmMeta = await sharp(wmBuffer).metadata();

  const pos = calculatePosition(CONFIG.position, imgW, imgH, wmMeta.width, wmMeta.height, CONFIG.margin);

  await baseImage
    .composite([{ input: wmBuffer, left: pos.left, top: pos.top, blend: 'over' }])
    .toFile(outputPath);
}

// ---------- Watermark untuk VIDEO (pakai ffmpeg) ---------- //

function overlayPosition(position, margin) {
  switch (position) {
    case 'top-left':
      return { x: `${margin}`, y: `${margin}` };
    case 'top-right':
      return { x: `main_w-overlay_w-${margin}`, y: `${margin}` };
    case 'bottom-left':
      return { x: `${margin}`, y: `main_h-overlay_h-${margin}` };
    case 'bottom-right':
      return { x: `main_w-overlay_w-${margin}`, y: `main_h-overlay_h-${margin}` };
    case 'center':
      return { x: `(main_w-overlay_w)/2`, y: `(main_h-overlay_h)/2` };
    default:
      return { x: `${margin}`, y: `${margin}` };
  }
}

async function processVideo(inputPath, outputPath, onProgress) {
  const duration = await getVideoDuration(inputPath); // detik, bisa 0 kalau gagal dibaca

  return new Promise((resolve, reject) => {
    const { x, y } = overlayPosition(CONFIG.position, CONFIG.margin);
    const scaleExpr = `scale=iw*${CONFIG.scale}:-1`;

    let wmFilter = `[1:v]${scaleExpr}`;
    if (CONFIG.opacity < 1) {
      wmFilter += `,format=rgba,colorchannelmixer=aa=${CONFIG.opacity}`;
    }
    wmFilter += `[wm]`;

    const filterComplex = `${wmFilter};[0:v][wm]overlay=${x}:${y}`;

    const ffmpegArgs = [
      '-y',
      '-i', inputPath,
      '-i', WATERMARK_PATH,
      '-filter_complex', filterComplex,
      '-codec:a', 'copy',
      '-preset', 'medium',
      '-progress', 'pipe:2', // ffmpeg cetak progress terstruktur ke stderr (out_time=..., dst)
      outputPath,
    ];

    const ff = spawn('ffmpeg', ffmpegArgs);
    let stderrTail = '';
    let buffer = '';

    ff.stderr.on('data', (d) => {
      const text = d.toString();
      stderrTail = (stderrTail + text).slice(-800); // simpan potongan terakhir untuk pesan error
      buffer += text;

      // ffmpeg -progress mencetak baris "key=value", salah satunya out_time=00:00:03.12
      const matches = buffer.match(/out_time=(\d{2}:\d{2}:\d{2}\.\d+)/g);
      if (matches && matches.length) {
        const last = matches[matches.length - 1];
        const timeStr = last.split('=')[1];
        const elapsed = timeStringToSeconds(timeStr);
        if (duration > 0 && onProgress) {
          const percent = (elapsed / duration) * 100;
          onProgress(percent);
        }
      }
    });

    ff.on('close', (code) => {
      if (code === 0) {
        if (onProgress) onProgress(100);
        resolve();
      } else {
        reject(new Error(stderrTail));
      }
    });
    ff.on('error', (err) => reject(err));
  });
}

// ---------- Main ---------- //

async function main() {
  console.log('🖼️  Watermark otomatis dimulai...\n');

  if (!fs.existsSync(WATERMARK_PATH)) {
    console.error(`❌ Watermark tidak ditemukan di: ${WATERMARK_PATH}`);
    console.error('   Taruh file watermark PNG di folder "image" dengan nama persis "watermark.png".');
    process.exit(1);
  }

  if (!fs.existsSync(INPUT_DIR)) {
    fs.mkdirSync(INPUT_DIR, { recursive: true });
  }
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const files = findMediaFiles(INPUT_DIR);
  if (files.length === 0) {
    console.log(`⚠️  Tidak ada gambar/video ditemukan di folder "input".`);
    console.log(`   Format gambar: ${IMAGE_EXTENSIONS.join(', ')}`);
    console.log(`   Format video : ${VIDEO_EXTENSIONS.join(', ')}`);
    return;
  }

  const hasVideos = files.some((f) => f.type === 'video');
  if (hasVideos) {
    const hasFfmpeg = await checkFfmpeg();
    if (!hasFfmpeg) {
      console.error('❌ ffmpeg tidak ditemukan di sistem ini, padahal ada video untuk diproses. Instal dulu:');
      console.error('   Ubuntu/Debian : sudo apt install ffmpeg');
      console.error('   macOS (brew)  : brew install ffmpeg');
      console.error('   Windows       : https://ffmpeg.org/download.html');
      process.exit(1);
    }
  }

  console.log(`📂 Ditemukan ${files.length} file di folder "input". Mulai memproses...\n`);

  let success = 0;
  let skipped = 0;
  let failed = 0;
  const isTTY = process.stdout.isTTY; // di beberapa terminal/log viewer, \r tidak didukung

  for (let i = 0; i < files.length; i++) {
    const { path: inputPath, type } = files[i];
    const relativeName = path.relative(INPUT_DIR, inputPath);
    const outputPath = path.join(OUTPUT_DIR, relativeName);
    const outputDir = path.dirname(outputPath);
    const label = `[${i + 1}/${files.length}] (${type}) ${relativeName}`;

    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    if (fs.existsSync(outputPath)) {
      console.log(`⏭️  ${label} — dilewati (sudah ada di output)`);
      skipped++;
      continue;
    }

    try {
      if (type === 'image') {
        // Gambar diproses sangat cepat, cukup tampilkan status mulai lalu selesai
        process.stdout.write(`⏳ ${label} ... `);
        await processImage(inputPath, outputPath);
        console.log('✅ selesai');
      } else {
        // Video: tampilkan progress bar yang update secara live di baris yang sama
        console.log(`⏳ ${label}`);
        const onProgress = (percent) => {
          const line = `   ${renderProgressBar(percent)}`;
          if (isTTY) {
            process.stdout.write(`\r${line}`);
          }
        };
        await processVideo(inputPath, outputPath, onProgress);
        if (isTTY) {
          process.stdout.write(`\r   ${renderProgressBar(100)} ✅ selesai\n`);
        } else {
          console.log(`   ${renderProgressBar(100)} ✅ selesai`);
        }
      }
      success++;
    } catch (err) {
      console.log('❌ gagal');
      console.error(`   Alasan: ${err.message}`);
      failed++;
    }
  }

  console.log(`\n📊 Ringkasan: ${success} berhasil, ${skipped} dilewati, ${failed} gagal dari total ${files.length} file.`);
  console.log(`📁 Hasil ada di folder: ${OUTPUT_DIR}`);
}

main().catch((err) => {
  console.error('❌ Terjadi kesalahan tak terduga:', err.message);
  process.exit(1);
});