# Extract & Restyle Subtitle (OCR) — Node.js

Script ini membaca subtitle yang sudah "terbakar" (burned-in) di video pakai OCR,
lalu menempelkannya kembali dengan tampilan yang lebih besar dan jelas.

Untuk setiap video di folder `input/`, script akan otomatis:
1. Crop area subtitle & ambil beberapa frame per detik
2. Bersihkan (threshold) gambar supaya teks lebih kontras
3. OCR tiap frame pakai Tesseract (bahasa Indonesia)
4. Gabungkan hasil OCR jadi baris subtitle lengkap dengan timing → file `.srt`
5. Blur subtitle asli, lalu tempel subtitle baru yang lebih besar & jelas
6. Simpan **video hasil** + **file `.srt`** ke folder `output/`

## Requirement

- **Node.js** 14+
- **ffmpeg** & **ffprobe**
- **tesseract-ocr** + paket bahasa Indonesia (`tesseract-ocr-ind`)

Install di Ubuntu/Debian:

```bash
sudo apt install ffmpeg tesseract-ocr tesseract-ocr-ind
```

Install di macOS (Homebrew):

```bash
brew install ffmpeg tesseract tesseract-lang
```

Cek instalasi:

```bash
ffmpeg -version
tesseract --list-langs   # pastikan "ind" muncul di daftar
```

## Struktur Folder

```
project/
├── extract-and-restyle-subtitle.js
├── input/        ← taruh video di sini
└── output/       ← dibuat otomatis, isi: video hasil + file .srt
```

## Cara Menjalankan

```bash
node extract-and-restyle-subtitle.js
```

Contoh output di terminal:

```
Ditemukan 1 video di ./input

[1/1] Memproses: video1.mp4
  - Ekstrak frame subtitle...
  - Threshold frame untuk OCR...
  - Menjalankan OCR (bisa agak lama)...
  - Menyusun baris subtitle...
  - SRT tersimpan: ./output/video1.srt (14 baris)
  - Render ulang video (blur lama + subtitle baru)...
  - Video tersimpan: ./output/video1.mp4

Selesai semua. Berhasil: 1, Gagal: 0
```

Hasil akhirnya ada 2 file per video:
- `video1.mp4` — video dengan subtitle baru yang lebih jelas
- `video1.srt` — file subtitle terpisah (bisa dipakai ulang / diedit manual)

## Pengaturan (Opsional)

| Argumen | Default | Keterangan |
|---|---|---|
| `--input` | Folder sumber video |
| `--output` | Folder hasil |
| `--x` | Posisi kiri area subtitle asli (pixel) |
| `--y` | Posisi atas area subtitle asli (pixel) |
| `--w` | Lebar area subtitle asli (pixel) |
| `--h` | Tinggi area subtitle asli (pixel) |
| `--fps` | Jumlah frame per detik yang di-OCR (makin besar = makin akurat timing, makin lama prosesnya) |
| `--sigma` | Kekuatan blur untuk menutup subtitle lama |
| `--fontsize` | Ukuran font subtitle baru |
| `--lang` | `ind` | Kode bahasa Tesseract untuk OCR |

Contoh custom:

```bash
node extract-and-restyle-subtitle.js --y=800 --h=200 --fontsize=20 --fps=8
```

**Cara menentukan `--x --y --w --h` yang pas** (kalau video kamu beda resolusi/posisi subtitle):
1. Ambil satu frame contoh: `ffmpeg -i input/video1.mp4 -ss 5 -vframes 1 sample.png`
2. Buka gambarnya, perkirakan posisi kotak yang membungkus area subtitle
3. Masukkan sebagai argumen `--x --y --w --h`

## Keterbatasan (Penting)

- **OCR tidak 100% akurat**, terutama pada frame yang blur karena gerakan kamera cepat.
  Selalu **cek file `.srt` yang dihasilkan** dan koreksi manual kalau ada baris yang aneh
  sebelum dipakai untuk keperluan penting.
- Proses ini cukup berat (ekstrak + OCR ratusan frame per video), jadi butuh waktu — video
  30 detik bisa makan waktu 1-2 menit tergantung spesifikasi komputer.
- Semakin banyak gerakan kamera / latar belakang terang di area subtitle, semakin besar
  kemungkinan OCR salah baca. Menaikkan `--fps` bisa membantu tapi juga menambah waktu proses.
- Font subtitle baru pakai `Arial Bold`. Kalau font itu tidak tersedia di sistem, ffmpeg akan
  otomatis pakai font default — ganti `FontName` di dalam script (bagian `renderVideo`) kalau
  mau font lain.

## Troubleshooting

| Masalah | Solusi |
|---|---|
| `tesseract: command not found` | Install tesseract-ocr (lihat bagian Requirement) |
| Hasil OCR kosong / banyak salah | Cek posisi `--x --y --w --h` sudah pas menutupi area subtitle |
| Error `Unable to open... .srt` saat render | Pastikan path folder tidak mengandung karakter aneh; jalankan dari folder project langsung |
| Subtitle baru miring/salah posisi | Sesuaikan `MarginV` dan `Alignment` di bagian `force_style` dalam script |
