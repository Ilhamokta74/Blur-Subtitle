# Blur Subtitle Video (Batch) — Node.js

Script untuk mem-blur area subtitle (burned-in) pada video secara otomatis.
Cukup taruh video di folder `input/`, jalankan script, hasilnya muncul di folder `output/`.

## Requirement

- **Node.js** versi 14 ke atas
- **ffmpeg** sudah terinstall dan bisa dipanggil dari terminal

Cek apakah ffmpeg sudah ada:

```bash
ffmpeg -version
```

Kalau belum ada, install dulu:

| OS | Perintah |
|---|---|
| Ubuntu / Debian | `sudo apt install ffmpeg` |
| macOS (Homebrew) | `brew install ffmpeg` |
| Windows | Download dari [ffmpeg.org/download.html](https://ffmpeg.org/download.html), lalu tambahkan ke PATH |

## Struktur Folder

Siapkan folder seperti ini:

```
project/
├── Blur.js
├── input/        ← taruh semua video di sini
│   ├── video1.mp4
│   ├── video2.mp4
│   └── video3.mov
└── output/       ← dibuat otomatis, hasil video ter-blur muncul di sini
```

Kalau folder `input/` atau `output/` belum ada, buat manual:

```bash
mkdir input output
```

Lalu pindahkan video-video yang mau diproses ke folder `input/`.

## Cara Menjalankan

Jalankan dengan pengaturan default:

```bash
node Blur.js
```

Script akan otomatis:

1. Membaca semua file video di folder `input/` (format `.mp4`, `.mov`, `.mkv`, `.avi`, `.webm`)
2. Mem-blur area subtitle di setiap video
3. Menyimpan hasilnya ke folder `output/` dengan nama file yang sama seperti aslinya
4. Menampilkan progres per file dan ringkasan berhasil/gagal di akhir

Contoh output di terminal:

```
Ditemukan 3 video di ./input

[1/3] Memproses: video1.mp4 ...
  -> Selesai: /project/output/video1.mp4

[2/3] Memproses: video2.mp4 ...
  -> Selesai: /project/output/video2.mp4

[3/3] Memproses: video3.mov ...
  -> Selesai: /project/output/video3.mov

Selesai semua. Berhasil: 3, Gagal: 0
```

## Mengatur Posisi & Ukuran Blur

Secara default, area yang di-blur diatur untuk video vertikal (576×1024) dengan subtitle di bagian bawah:

| Parameter | Default | Keterangan |
|---|---|---|
| `--x` | `0` | Posisi kiri area blur (pixel) |
| `--y` | `610` | Posisi atas area blur (pixel) |
| `--w` | `576` | Lebar area blur (pixel) |
| `--h` | `170` | Tinggi area blur (pixel) |
| `--sigma` | `25` | Tingkat kekuatan blur (semakin besar semakin buram) |

Jika video kamu punya resolusi atau posisi subtitle berbeda, sesuaikan nilainya:

```bash
node Blur.js --x=0 --y=800 --w=1080 --h=200 --sigma=30
```

**Cara menentukan koordinat yang pas:**
1. Ambil satu frame contoh dari video (misalnya pakai `ffmpeg -i input/video1.mp4 -vf "select=eq(n\,50)" -vframes 1 sample.png`)
2. Buka gambarnya, catat posisi kira-kira di mana subtitle muncul (dari kiri = `x`, dari atas = `y`, lebar = `w`, tinggi = `h`)
3. Masukkan nilai tersebut sebagai argumen

## Mengatur Folder Input/Output

Kalau tidak mau pakai folder `input/` dan `output/` default:

```bash
node Blur.js --input=./videos-mentah --output=./videos-hasil
```

## Catatan

- File asli di folder `input/` **tidak diubah/dihapus** — script hanya membaca lalu menulis hasil baru ke `output/`.
- Kalau nama file output sudah ada sebelumnya, akan **ditimpa otomatis**.
- Kalau satu video gagal diproses (misal file rusak), script akan tetap lanjut ke video berikutnya dan melaporkan errornya di akhir.
- Audio tidak ikut diproses ulang (di-copy langsung) supaya lebih cepat dan tidak kehilangan kualitas.
