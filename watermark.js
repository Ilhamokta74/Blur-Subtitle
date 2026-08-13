const fs = require("fs");
const path = require("path");
const readline = require("readline");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegStatic = require("ffmpeg-static");

// =====================================================
// PATH
// =====================================================

const INPUT_DIR = path.join(__dirname, "input");
const OUTPUT_DIR = path.join(__dirname, "output");

const WATERMARK_PATH = path.join(
    __dirname,
    "watermark.png"
);

const PREVIEW_PATH = path.join(
    __dirname,
    "preview.png"
);

// =====================================================
// WATERMARK CONFIG
// =====================================================

const watermark = {

    // =================================================
    // POSITION
    // =================================================
    //
    // Pilihan:
    //
    // "top-left"
    // "top-right"
    // "center"
    // "bottom-left"
    // "bottom-right"
    // "custom"
    //
    position: "custom",

    // Hanya digunakan jika position = "custom"
    x: 700,
    y: 300,

    // Lebar watermark
    // Tinggi otomatis mengikuti aspect ratio PNG
    width: 300,

    // Transparansi
    //
    // 1.0 = 100%
    // 0.8 = 80%
    // 0.5 = 50%
    //
    opacity: 0.8
};

// =====================================================
// VIDEO EXTENSIONS
// =====================================================

const VIDEO_EXTENSIONS = [
    ".mp4",
    ".mkv",
    ".mov",
    ".avi",
    ".webm",
    ".m4v"
];

// =====================================================
// FFMPEG
// =====================================================

if (ffmpegStatic) {
    ffmpeg.setFfmpegPath(ffmpegStatic);
}

// =====================================================
// CREATE FOLDER
// =====================================================

if (!fs.existsSync(INPUT_DIR)) {
    fs.mkdirSync(INPUT_DIR, {
        recursive: true
    });
}

if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, {
        recursive: true
    });
}

// =====================================================
// GET VIDEOS
// =====================================================

function getVideos() {

    return fs
        .readdirSync(INPUT_DIR)
        .filter(file => {

            const ext = path
                .extname(file)
                .toLowerCase();

            return VIDEO_EXTENSIONS.includes(ext);
        });
}

// =====================================================
// GET WATERMARK POSITION
// =====================================================

function getPosition() {

    switch (watermark.position) {

        case "top-left":

            return {
                x: 20,
                y: 20
            };

        case "top-right":

            return {
                x: "main_w-overlay_w-20",
                y: 20
            };

        case "center":

            return {
                x: "(main_w-overlay_w)/2",
                y: "(main_h-overlay_h)/2"
            };

        case "bottom-left":

            return {
                x: 20,
                y: "main_h-overlay_h-20"
            };

        case "bottom-right":

            return {
                x: "main_w-overlay_w-20",
                y: "main_h-overlay_h-20"
            };

        case "custom":

            return {
                x: watermark.x,
                y: watermark.y
            };

        default:

            throw new Error(
                `Position "${watermark.position}" tidak valid.`
            );
    }
}

// =====================================================
// SHOW CONFIG
// =====================================================

function showConfig() {

    const position = getPosition();

    console.log("");
    console.log("==========================================");
    console.log("          WATERMARK CONFIGURATION");
    console.log("==========================================");

    console.log(
        `Position : ${watermark.position}`
    );

    if (watermark.position === "custom") {

        console.log(
            `X        : ${watermark.x}`
        );

        console.log(
            `Y        : ${watermark.y}`
        );
    }

    console.log(
        `Width    : ${watermark.width}px`
    );

    console.log(
        `Opacity  : ${watermark.opacity * 100}%`
    );

    console.log(
        `Preview  : ${PREVIEW_PATH}`
    );

    console.log("==========================================");
}

// =====================================================
// CREATE PREVIEW
// =====================================================

function createPreview(videoPath) {

    return new Promise((resolve, reject) => {

        const position = getPosition();

        console.log("");
        console.log("==========================================");
        console.log("           CREATING PREVIEW");
        console.log("==========================================");

        console.log(
            `Video: ${path.basename(videoPath)}`
        );

        // Ambil frame pertama
        ffmpeg(videoPath)

            // Watermark
            .input(WATERMARK_PATH)

            .complexFilter([

                // -------------------------------------
                // Scale watermark
                // -------------------------------------

                {
                    filter: "scale",
                    options: {
                        w: watermark.width,
                        h: -1
                    },
                    inputs: "1:v",
                    outputs: "wm_scaled"
                },

                // -------------------------------------
                // Ubah ke RGBA
                // -------------------------------------

                {
                    filter: "format",
                    options: "rgba",
                    inputs: "wm_scaled",
                    outputs: "wm_rgba"
                },

                // -------------------------------------
                // Opacity
                // -------------------------------------

                {
                    filter: "colorchannelmixer",
                    options: {
                        aa: watermark.opacity
                    },
                    inputs: "wm_rgba",
                    outputs: "wm_opacity"
                },

                // -------------------------------------
                // Overlay
                // -------------------------------------

                {
                    filter: "overlay",
                    options: {
                        x: position.x,
                        y: position.y
                    },
                    inputs: [
                        "0:v",
                        "wm_opacity"
                    ],
                    outputs: "preview"
                }

            ])

            .outputOptions([
                "-map [preview]",
                "-frames:v 1"
            ])

            .on("start", command => {

                console.log("");
                console.log("FFmpeg Preview:");
                console.log(command);
                console.log("");
            })

            .on("end", () => {

                console.log("");
                console.log("✅ Preview berhasil dibuat!");
                console.log("");

                resolve();

            })

            .on("error", error => {

                console.error("");
                console.error(
                    "❌ Gagal membuat preview:"
                );

                console.error(
                    error.message
                );

                reject(error);
            })

            .save(PREVIEW_PATH);
    });
}

// =====================================================
// ASK YES / NO
// =====================================================

function askConfirmation() {

    return new Promise(resolve => {

        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        console.log("");
        console.log("==========================================");
        console.log("             DOUBLE CHECK");
        console.log("==========================================");

        console.log("");
        console.log(
            "Silakan buka file:"
        );

        console.log(
            PREVIEW_PATH
        );

        console.log("");

        console.log(
            "Pastikan posisi watermark sudah benar."
        );

        console.log("");

        rl.question(
            "Lanjut proses semua video? (yes/no): ",
            answer => {

                rl.close();

                const normalized =
                    answer
                        .trim()
                        .toLowerCase();

                resolve(
                    normalized === "yes" ||
                    normalized === "y"
                );
            }
        );
    });
}

// =====================================================
// PROCESS ONE VIDEO
// =====================================================

function processVideo(
    inputFile,
    outputFile
) {

    return new Promise((resolve, reject) => {

        const position = getPosition();

        ffmpeg(inputFile)

            .input(WATERMARK_PATH)

            .complexFilter([

                // Scale watermark
                {
                    filter: "scale",
                    options: {
                        w: watermark.width,
                        h: -1
                    },
                    inputs: "1:v",
                    outputs: "wm_scaled"
                },

                // RGBA
                {
                    filter: "format",
                    options: "rgba",
                    inputs: "wm_scaled",
                    outputs: "wm_rgba"
                },

                // Opacity
                {
                    filter: "colorchannelmixer",
                    options: {
                        aa: watermark.opacity
                    },
                    inputs: "wm_rgba",
                    outputs: "wm_opacity"
                },

                // Overlay
                {
                    filter: "overlay",
                    options: {
                        x: position.x,
                        y: position.y
                    },
                    inputs: [
                        "0:v",
                        "wm_opacity"
                    ],
                    outputs: "final"
                }

            ])

            .outputOptions([

                "-map [final]",

                // Audio tetap diambil
                "-map 0:a?",

                // Video codec
                "-c:v libx264",

                // Kualitas
                "-preset medium",
                "-crf 18",

                // Audio
                "-c:a aac",
                "-b:a 192k",

                // Optimasi MP4
                "-movflags +faststart"

            ])

            .on("progress", progress => {

                if (progress.percent) {

                    const percent =
                        Math.min(
                            100,
                            progress.percent
                        );

                    process.stdout.write(
                        `\rProgress: ${percent.toFixed(1)}%`
                    );
                }
            })

            .on("end", () => {

                process.stdout.write(
                    "\rProgress: 100.0%\n"
                );

                resolve();

            })

            .on("error", error => {

                console.log("");

                reject(error);
            })

            .save(outputFile);
    });
}

// =====================================================
// MAIN
// =====================================================

async function main() {

    console.clear();

    console.log("");
    console.log("==========================================");
    console.log("       AUTOMATIC VIDEO WATERMARK");
    console.log("==========================================");

    // -----------------------------------------------
    // Check watermark
    // -----------------------------------------------

    if (!fs.existsSync(WATERMARK_PATH)) {

        console.error("");
        console.error(
            "❌ watermark.png tidak ditemukan!"
        );

        console.error("");
        console.error(
            `Letakkan watermark di:`
        );

        console.error(
            WATERMARK_PATH
        );

        return;
    }

    // -----------------------------------------------
    // Get videos
    // -----------------------------------------------

    const videos = getVideos();

    if (videos.length === 0) {

        console.error("");
        console.error(
            "❌ Tidak ada video di folder input!"
        );

        console.error("");
        console.error(
            `Masukkan video ke: ${INPUT_DIR}`
        );

        return;
    }

    console.log("");
    console.log(
        `🎬 Video ditemukan: ${videos.length}`
    );

    // -----------------------------------------------
    // Show config
    // -----------------------------------------------

    showConfig();

    // -----------------------------------------------
    // Preview menggunakan video pertama
    // -----------------------------------------------

    const firstVideo = path.join(
        INPUT_DIR,
        videos[0]
    );

    await createPreview(firstVideo);

    // -----------------------------------------------
    // Double check
    // -----------------------------------------------

    const confirmed =
        await askConfirmation();

    // -----------------------------------------------
    // CANCEL
    // -----------------------------------------------

    if (!confirmed) {

        console.log("");
        console.log(
            "❌ Proses dibatalkan."
        );

        console.log(
            "Tidak ada video yang diproses."
        );

        console.log("");

        return;
    }

    // -----------------------------------------------
    // START PROCESSING
    // -----------------------------------------------

    console.log("");
    console.log("==========================================");
    console.log("          START PROCESSING");
    console.log("==========================================");

    let success = 0;
    let failed = 0;

    // -----------------------------------------------
    // Process sequentially
    // -----------------------------------------------

    for (let i = 0; i < videos.length; i++) {

        const file = videos[i];

        const inputFile = path.join(
            INPUT_DIR,
            file
        );

        const outputFile = path.join(
            OUTPUT_DIR,
            file
        );

        console.log("");
        console.log(
            `🎬 [${i + 1}/${videos.length}] ${file}`
        );

        try {

            await processVideo(
                inputFile,
                outputFile
            );

            console.log(
                `✅ [${i + 1}/${videos.length}] Selesai`
            );

            success++;

        } catch (error) {

            console.log(
                `❌ [${i + 1}/${videos.length}] Gagal`
            );

            console.error(
                error.message
            );

            failed++;
        }
    }

    // -----------------------------------------------
    // RESULT
    // -----------------------------------------------

    console.log("");
    console.log("==========================================");
    console.log("             ALL DONE");
    console.log("==========================================");

    console.log(
        `Total    : ${videos.length}`
    );

    console.log(
        `Berhasil : ${success}`
    );

    console.log(
        `Gagal    : ${failed}`
    );

    console.log("");

    console.log(
        `📂 Output: ${OUTPUT_DIR}`
    );

    console.log("");
}

// =====================================================
// RUN
// =====================================================

main().catch(error => {

    console.error("");
    console.error("❌ Fatal Error:");
    console.error(error);
});