import express from "express";
import BG from "bgutils-js";
import { JSDOM } from "jsdom";
import { Innertube, UniversalCache } from "youtubei.js";

const app = express();
const port = 3000;

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
		const allFormats = info.streaming_data.adaptive_formats;

		// Decipher URLs for all formats
		const decipheredUrls = allFormats.map((format) => {
			try {
				const url = format.decipher(innertube.session.player);
				return { ...format, url };
			} catch (error) {
				console.error(`Error deciphering format ${format.itag}:`, error);
				return { format: format.itag, url: null };
			}
		});

		// Prepare response with video title, thumbnail, and deciphered URLs
		const response = {
			title: info.basic_info.title,
			thumbnail: info.basic_info.thumbnail[0].url,
			decipheredUrls,
		};

		// Send the response
		res.json(response);
	} catch (error) {
		console.error("Error:", error);
		res.status(500).json({ error: "An error occurred" });
	}
});

// Start the server
app.listen(port, () => {
	console.log(`Server is running on http://localhost:${port}`);
});
