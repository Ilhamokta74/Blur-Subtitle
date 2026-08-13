const fs = require("fs");
const path = require("path");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegStatic = require("ffmpeg-static");

// =====================================================
// CONFIGURATION
// =====================================================

const INPUT_DIR = path.join(__dirname, "input");
const OUTPUT_DIR = path.join(__dirname, "output");
const WATERMARK_PATH = path.join(__dirname, "./watermark/watermark.png");

// =====================================================
// WATERMARK CONFIG
// =====================================================

const watermark = {
    // Pilihan:
    // "top-left"
    // "top-right"
    // "center"
    // "bottom-left"
    // "bottom-right"
    // "custom"

    position: "custom",

    // Digunakan kalau position = "custom"
    x: 1550,
    y: 900,

    // Lebar watermark dalam pixel
    // Tinggi akan mengikuti aspect ratio watermark
    width: 300,

    // Opacity watermark
    // 1.0 = 100%
    // 0.8 = 80%
    // 0.5 = 50%
    opacity: 0.8
};

// =====================================================
// FFMPEG
// =====================================================

if (ffmpegStatic) {
    ffmpeg.setFfmpegPath(ffmpegStatic);
}

// =====================================================
// CREATE FOLDERS
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
// CHECK WATERMARK
// =====================================================

if (!fs.existsSync(WATERMARK_PATH)) {
    console.error("❌ watermark.png tidak ditemukan!");
    console.error(`   Letakkan watermark di: ${WATERMARK_PATH}`);
    process.exit(1);
}

// =====================================================
// SUPPORTED VIDEO
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
// GET POSITION
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
// PROCESS ONE VIDEO
// =====================================================

function processVideo(inputFile, outputFile) {

    return new Promise((resolve, reject) => {

        const position = getPosition();

        console.log("");
        console.log("==========================================");
        console.log("Processing:");
        console.log(path.basename(inputFile));
        console.log("==========================================");

        console.log(
            `Watermark position: ${watermark.position}`
        );

        if (watermark.position === "custom") {
            console.log(
                `X: ${watermark.x} | Y: ${watermark.y}`
            );
        }

        console.log(
            `Watermark width: ${watermark.width}px`
        );

        console.log(
            `Opacity: ${watermark.opacity * 100}%`
        );

        ffmpeg(inputFile)

            // Watermark
            .input(WATERMARK_PATH)

            // Complex filter
            .complexFilter([
                {
                    filter: "scale",
                    options: {
                        w: watermark.width,
                        h: -1
                    },
                    inputs: "1:v",
                    outputs: "watermark_scaled"
                },
                {
                    filter: "format",
                    options: "rgba",
                    inputs: "watermark_scaled",
                    outputs: "watermark_rgba"
                },
                {
                    filter: "colorchannelmixer",
                    options: {
                        aa: watermark.opacity
                    },
                    inputs: "watermark_rgba",
                    outputs: "watermark_opacity"
                },
                {
                    filter: "overlay",
                    options: {
                        x: position.x,
                        y: position.y
                    },
                    inputs: [
                        "0:v",
                        "watermark_opacity"
                    ],
                    outputs: "final"
                }
            ])

            .outputOptions([
                "-map [final]",
                "-map 0:a?",
                "-c:v libx264",
                "-preset medium",
                "-crf 18",
                "-c:a aac",
                "-b:a 192k",
                "-movflags +faststart"
            ])

            .on("start", commandLine => {
                console.log("");
                console.log("FFmpeg command:");
                console.log(commandLine);
                console.log("");
            })

            .on("progress", progress => {

                if (progress.percent) {

                    const percent = Math.min(
                        100,
                        progress.percent
                    );

                    process.stdout.write(
                        `\rProgress: ${percent.toFixed(1)}%`
                    );
                }
            })

            .on("end", () => {

                console.log("");
                console.log(
                    `✅ Selesai: ${path.basename(outputFile)}`
                );

                resolve();
            })

            .on("error", error => {

                console.log("");

                console.error(
                    `❌ Error: ${path.basename(inputFile)}`
                );

                console.error(error.message);

                reject(error);
            })

            .save(outputFile);
    });
}

// =====================================================
// MAIN
// =====================================================

async function main() {

    console.log("");
    console.log("==========================================");
    console.log("       VIDEO WATERMARK PROCESSOR");
    console.log("==========================================");
    console.log("");

    const files = fs
        .readdirSync(INPUT_DIR)
        .filter(file => {

            const extension = path
                .extname(file)
                .toLowerCase();

            return VIDEO_EXTENSIONS.includes(extension);
        });

    if (files.length === 0) {

        console.log("❌ Tidak ada video di folder input.");

        console.log("");
        console.log("Masukkan video ke:");
        console.log(INPUT_DIR);

        return;
    }

    console.log(`📁 Ditemukan ${files.length} video.`);

    console.log("");
    console.log("Watermark:");
    console.log(`Position : ${watermark.position}`);
    console.log(`Width    : ${watermark.width}px`);
    console.log(`Opacity  : ${watermark.opacity * 100}%`);

    if (watermark.position === "custom") {
        console.log(`X        : ${watermark.x}`);
        console.log(`Y        : ${watermark.y}`);
    }

    console.log("");

    let success = 0;
    let failed = 0;

    for (let i = 0; i < files.length; i++) {

        const file = files[i];

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
            `🎬 [${i + 1}/${files.length}] ${file}`
        );

        try {

            await processVideo(
                inputFile,
                outputFile
            );

            success++;

        } catch (error) {

            failed++;

            console.error(
                `❌ Gagal memproses ${file}`
            );
        }
    }

    console.log("");
    console.log("==========================================");
    console.log("              SELESAI");
    console.log("==========================================");

    console.log(
        `Total   : ${files.length}`
    );

    console.log(
        `Berhasil: ${success}`
    );

    console.log(
        `Gagal   : ${failed}`
    );

    console.log("");
    console.log(
        `📂 Hasil berada di: ${OUTPUT_DIR}`
    );
}

main().catch(error => {

    console.error("");
    console.error("❌ Fatal Error:");
    console.error(error);

});