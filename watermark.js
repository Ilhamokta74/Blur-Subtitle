#!/usr/bin/env node
/**
 * watermark.js
 * Menambahkan watermark PNG (dengan transparansi) ke gambar.
 *
 * Contoh pemakaian:
 *   node watermark.js --input foto.jpg --watermark logo.png --output hasil.jpg
 *   node watermark.js --input foto.jpg --watermark logo.png --output hasil.jpg --position bottom-right --scale 0.2 --opacity 0.6 --margin 20
 *
 * Opsi:
 *   --input      Path gambar sumber (wajib)
 *   --watermark  Path file watermark PNG (wajib)
 *   --output     Path file hasil (wajib)
 *   --position   top-left | top-right | bottom-left | bottom-right | center (default: bottom-right)
 *   --scale      Lebar watermark relatif terhadap lebar gambar, 0-1 (default: 0.2 = 20%)
 *   --opacity    Transparansi watermark, 0-1 (default: 1 / tidak diubah)
 *   --margin     Jarak watermark dari tepi gambar dalam px (default: 20)
 *   --tile       Jika diisi "true", watermark diulang memenuhi seluruh gambar
 */

const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    position: 'bottom-right',
    scale: 0.2,
    opacity: 1,
    margin: 20,
    tile: false,
  };

  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key.startsWith('--')) {
      const name = key.slice(2);
      const value = args[i + 1];
      if (name === 'tile') {
        opts.tile = value === 'true';
      } else if (['scale', 'opacity', 'margin'].includes(name)) {
        opts[name] = parseFloat(value);
      } else {
        opts[name] = value;
      }
      i++;
    }
  }
  return opts;
}

function validateOpts(opts) {
  const required = ['input', 'watermark', 'output'];
  const missing = required.filter((k) => !opts[k]);
  if (missing.length) {
    console.error(`❌ Argumen wajib belum diisi: ${missing.join(', ')}`);
    printHelp();
    process.exit(1);
  }
  if (!fs.existsSync(opts.input)) {
    console.error(`❌ File input tidak ditemukan: ${opts.input}`);
    process.exit(1);
  }
  if (!fs.existsSync(opts.watermark)) {
    console.error(`❌ File watermark tidak ditemukan: ${opts.watermark}`);
    process.exit(1);
  }
  const validPositions = ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center'];
  if (!validPositions.includes(opts.position)) {
    console.error(`❌ Posisi tidak valid: ${opts.position}. Pilihan: ${validPositions.join(', ')}`);
    process.exit(1);
  }
}

function printHelp() {
  console.log(`
Cara pakai:
  node watermark.js --input <gambar> --watermark <logo.png> --output <hasil>

Opsi tambahan:
  --position   top-left | top-right | bottom-left | bottom-right | center (default: bottom-right)
  --scale      lebar watermark relatif terhadap lebar gambar, 0-1 (default: 0.2)
  --opacity    transparansi watermark, 0-1 (default: 1)
  --margin     jarak dari tepi gambar dalam px (default: 20)
  --tile       true/false, ulangi watermark memenuhi gambar (default: false)

Contoh:
  node watermark.js --input foto.jpg --watermark logo.png --output hasil.jpg --position bottom-right --scale 0.15 --opacity 0.6
`);
}

async function applyOpacity(buffer, opacity) {
  if (opacity >= 1) return buffer;
  // Kurangi channel alpha watermark sesuai opacity
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

async function main() {
  const opts = parseArgs();
  validateOpts(opts);

  const baseImage = sharp(opts.input);
  const baseMeta = await baseImage.metadata();
  const imgW = baseMeta.width;
  const imgH = baseMeta.height;

  // Resize watermark relatif terhadap lebar gambar
  const wmTargetWidth = Math.round(imgW * opts.scale);
  let wmBuffer = await sharp(opts.watermark)
    .resize({ width: wmTargetWidth })
    .png()
    .toBuffer();

  // Terapkan opacity jika < 1
  wmBuffer = await applyOpacity(wmBuffer, opts.opacity);

  const wmMeta = await sharp(wmBuffer).metadata();

  let compositeOptions;

  if (opts.tile) {
    // Mode tile: ulangi watermark ke seluruh gambar
    compositeOptions = [{ input: wmBuffer, tile: true, blend: 'over' }];
  } else {
    const pos = calculatePosition(
      opts.position,
      imgW,
      imgH,
      wmMeta.width,
      wmMeta.height,
      opts.margin
    );
    compositeOptions = [{ input: wmBuffer, left: pos.left, top: pos.top, blend: 'over' }];
  }

  await baseImage
    .composite(compositeOptions)
    .toFile(opts.output);

  console.log(`✅ Berhasil! Gambar dengan watermark disimpan di: ${opts.output}`);
  console.log(`   Ukuran gambar: ${imgW}x${imgH}px | Watermark: ${wmMeta.width}x${wmMeta.height}px`);
}

main().catch((err) => {
  console.error('❌ Terjadi kesalahan:', err.message);
  process.exit(1);
});