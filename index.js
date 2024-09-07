import express from "express";
import BG from "bgutils-js";
import { JSDOM } from "jsdom";
import { Innertube, UniversalCache } from "youtubei.js";
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import dotenv from "dotenv";

dotenv.config();
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const app = express();
const port = process.env.PORT || 5000;
app.use(express.json());

const WASABI_BUCKET = "yt-storage"; // Make sure this is correct

// Initialize S3 client
const s3Client = new S3Client({
  region: "ap-southeast-1", // Make sure this is correct for your Wasabi setup
  endpoint: "https://s3.ap-southeast-1.wasabisys.com", // Updated endpoint
  credentials: {
    accessKeyId: process.env.WASABI_ACCESS_KEY_ID,
    secretAccessKey: process.env.WASABI_SECRET_ACCESS_KEY,
  },
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Helper function to extract YouTube video ID from various URL formats
function extractVideoId(url) {
  const regex =
    /(?:youtube\.com\/(?:[^/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/|shorts\/)([^"&?/\s]{11})/;
  const match = url.match(regex);
  return match ? match[1] : null;
}

// Endpoint to handle YouTube URL requests
app.get("/decipher", async (req, res) => {
  try {
    const { url } = req.query;

    if (!url) {
      return res.status(400).json({ error: "No URL provided" });
    }

    // Extract video ID from the provided URL
    const videoId = extractVideoId(url);
    if (!videoId) {
      return res.status(400).json({ error: "Invalid YouTube URL" });
    }

    // Create an Innertube session with player retrieval disabled
    let innertube = await Innertube.create({ retrieve_player: false });

    const requestKey = "O43z0dpjhgX20SCx4KAo";
    const visitorData = innertube.session.context.client.visitorData;

    // Set up a global environment for Botguard execution
    const dom = new JSDOM();
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
    });

    // Configure Botguard (BG) settings
    const bgConfig = {
      fetch: (url, options) => fetch(url, options),
      globalObj: globalThis,
      identifier: visitorData,
      requestKey,
    };

    // Create a Botguard challenge
    const challenge = await BG.Challenge.create(bgConfig);
    if (!challenge) throw new Error("Could not get challenge");

    // Execute Botguard challenge script if available
    if (challenge.script) {
      const script = challenge.script.find((sc) => sc !== null);
      if (script) new Function(script)();
    } else {
      console.warn("Unable to load Botguard.");
    }

    // Generate PoToken for further requests
    const poToken = await BG.PoToken.generate({
      program: challenge.challenge,
      globalName: challenge.globalName,
      bgConfig,
    });

    // Create a new Innertube session with the generated tokens
    innertube = await Innertube.create({
      po_token: poToken,
      visitor_data: visitorData,
      cache: new UniversalCache(),
      generate_session_locally: true,
    });

    // Fetch video information
    const info = await innertube.getBasicInfo(videoId);

    // Extract all available formats from the video information
    const allFormats = [
      ...info.streaming_data.adaptive_formats,
      ...info.streaming_data.formats,
    ];

    // Decipher URLs for all formats
    const decipheredUrls = allFormats.map((format) => {
      try {
        const url = format.decipher(innertube.session.player);
        const hasVideo = format.has_video;
        const hasAudio = format.has_audio;

        return {
          itag: format.itag,
          qualityLabel: format.has_video
            ? format.quality_label
            : format.audio_quality,
          container: format.container,
          size: format.content_length
            ? (Number(format.content_length) / (1024 * 1024)).toFixed(2) + " MB"
            : "N/A",
          type: format.has_video ? "video" : "audio",
          is60fps: format.fps == 60,
          url,
          hasVideo,
          hasAudio,
        };
      } catch (error) {
        console.error(`Error deciphering format ${format.itag}:`, error);
        return {
          itag: format.itag,
          qualityLabel: format.quality_label || "Audio only",
          container: format.container,
          size: "N/A",
          type: "unknown",
          is60fps: false,
          url: null,
        };
      }
    });

    // Prepare response with video title, thumbnail, and deciphered URLs
    const response = {
      title: info.basic_info.title,
      duration: info.basic_info.duration,
      thumbnail: info.basic_info.thumbnail[0].url,
      formats: decipheredUrls,
    };

    // Send the response
    res.json(response);
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ error: "An error occurred" });
  }
});

app.post("/convert", async (req, res) => {
  console.log("File processing started");
  let tempFilePath = null;
  try {
    const { audioUrl, videoUrl, title, vId, vq } = req.body;
    if (!audioUrl || !videoUrl || !title || !vId || !vq) {
      return res.status(400).json({ error: "Missing required parameters" });
    }

    const sanitizedTitle = title.replace(/[^a-z0-9]/gi, "_").toLowerCase();
    const outputFileName = `${sanitizedTitle}-${vq}.mp4`;
    const wasabiKey = `${vId}/${sanitizedTitle}-${vq}.mp4`;
    console.log(`Checking if file exists: ${wasabiKey}`);

    // Check if file already exists in Wasabi
    try {
      await s3Client.send(
        new HeadObjectCommand({
          Bucket: WASABI_BUCKET,
          Key: wasabiKey,
        })
      );

      console.log("File exists, generating signed URL");

      // File exists, generate signed URL and return
      const signedUrl = await getSignedUrl(
        s3Client,
        new GetObjectCommand({
          Bucket: WASABI_BUCKET,
          Key: wasabiKey,
        }),
        { expiresIn: 3600 }
      );
      return res.json({ downloadUrl: signedUrl });
    } catch (error) {
      if (error.name !== "NotFound") {
        console.error("Error checking file existence:", error);
        throw error; // Re-throw if it's not a 'NotFound' error
      }
      console.log("File doesn't exist, proceeding with download and upload");
    }

    tempFilePath = path.join(__dirname, "temp", outputFileName);

    // Ensure temp directory exists
    if (!fs.existsSync(path.dirname(tempFilePath))) {
      fs.mkdirSync(path.dirname(tempFilePath), { recursive: true });
    }

    console.log("Downloading and merging audio and video");

    // Download and merge audio and video
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(videoUrl)
        .input(audioUrl)
        .outputOptions("-c:v copy")
        .outputOptions("-c:a aac")
        .output(tempFilePath)
        .on("end", resolve)
        .on("error", reject)
        .run();
    });

    console.log("Upload to Wasabi");

    // Upload to Wasabi
    const fileContent = fs.readFileSync(tempFilePath);
    const params = {
      Bucket: WASABI_BUCKET,
      Key: wasabiKey,
      Body: fileContent,
      ContentType: "video/mp4",
    };

    await s3Client.send(new PutObjectCommand(params));

    console.log("Generating signed URL for download");

    // Generate signed URL for download
    const signedUrl = await getSignedUrl(
      s3Client,
      new GetObjectCommand({
        Bucket: WASABI_BUCKET,
        Key: wasabiKey,
      }),
      { expiresIn: 3600 }
    );

    res.json({ downloadUrl: signedUrl });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({
      error:
        error.message || "An error occurred during download and upload process",
    });
  } finally {
    // Clean up temporary file
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try {
        fs.unlinkSync(tempFilePath);
        console.log(`Temporary file deleted: ${tempFilePath}`);
      } catch (unlinkError) {
        console.error(`Error deleting temporary file: ${unlinkError.message}`);
      }
    }
  }
});

// Start the server
app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
