const express = require("express");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegStatic = require("ffmpeg-static");
const { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } = require("@aws-sdk/client-s3");
const fs = require("fs");
const path = require("path");
const os = require("os");

ffmpeg.setFfmpegPath(ffmpegStatic);

const app = express();
app.use(express.json({ limit: "50mb" }));

function createR2Client(config) {
  return new S3Client({
    region: "auto",
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

async function downloadFromR2(client, bucket, key, localPath) {
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const writeStream = fs.createWriteStream(localPath);
  await new Promise((resolve, reject) => {
    response.Body.pipe(writeStream).on("finish", resolve).on("error", reject);
  });
}

async function uploadToR2(client, bucket, key, localPath, contentType) {
  const fileBuffer = fs.readFileSync(localPath);
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: fileBuffer,
    ContentType: contentType,
  }));
}

async function uploadDirectoryToR2(client, bucket, localDir, r2Prefix) {
  const files = fs.readdirSync(localDir);
  for (const file of files) {
    const localPath = path.join(localDir, file);
    if (fs.statSync(localPath).isDirectory()) continue;
    const r2Key = `${r2Prefix}/${file}`;
    const ext = path.extname(file).toLowerCase();
    let contentType = "application/octet-stream";
    if (ext === ".mpd") contentType = "application/dash+xml";
    else if (ext === ".mp4" || ext === ".m4s") contentType = "video/mp4";
    else if (ext === ".m4a") contentType = "audio/mp4";
    console.log(`Uploading ${file} to R2...`);
    await uploadToR2(client, bucket, r2Key, localPath, contentType);
  }
}

function transcodeVideo(inputPath, outputDir) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(outputDir, { recursive: true });
    const outputManifest = path.join(outputDir, "manifest.mpd");

    ffmpeg(inputPath)
      .outputOptions([
        "-map", "0:v:0",
        "-map", "0:v:0",
        "-map", "0:a:0",
        "-b:v:0", "2800k",
        "-s:v:0", "1280x720",
        "-profile:v:0", "main",
        "-b:v:1", "1400k",
        "-s:v:1", "854x480",
        "-profile:v:1", "baseline",
        "-b:a:0", "128k",
        "-c:v", "libx264",
        "-c:a", "aac",
        "-ar", "44100",
        "-use_timeline", "1",
        "-use_template", "1",
        "-seg_duration", "4",
        "-adaptation_sets", "id=0,streams=v id=1,streams=a",
        "-f", "dash",
      ])
      .output(outputManifest)
      .on("start", (cmd) => console.log("FFmpeg started"))
      .on("progress", (p) => console.log(`Progress: ${Math.round(p.percent || 0)}%`))
      .on("end", () => { console.log("Transcoding complete!"); resolve(); })
      .on("error", (err) => { console.error("FFmpeg error:", err.message); reject(err); })
      .run();
  });
}

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.post("/transcode", async (req, res) => {
  const { inputKey, outputPrefix, r2Config } = req.body;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "transcode-"));
  const inputPath = path.join(tempDir, "input.mp4");
  const outputDir = path.join(tempDir, "output");

  try {
    const r2 = createR2Client(r2Config);
    console.log(`Downloading ${inputKey} from R2...`);
    await downloadFromR2(r2, r2Config.bucketName, inputKey, inputPath);
    console.log("Transcoding...");
    await transcodeVideo(inputPath, outputDir);
    console.log("Uploading DASH segments to R2...");
    await uploadDirectoryToR2(r2, r2Config.bucketName, outputDir, outputPrefix);
    fs.rmSync(tempDir, { recursive: true });
    res.json({ success: true, manifestKey: `${outputPrefix}/manifest.mpd` });
  } catch (err) {
    console.error("Error:", err.message);
    fs.rmSync(tempDir, { recursive: true, force: true });
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(3001, () => console.log("Transcoder running on http://localhost:3001"));