import BG from "bgutils-js";
import { JSDOM } from "jsdom";
import { Innertube, UniversalCache, Utils } from "youtubei.js";

// Create an Innertube session with player retrieval enabled
let innertube = await Innertube.create({ retrieve_player: false });

// Prepare the required parameters for Botguard challenge
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

// Log the session info
console.log("Session Info:", {
	visitorData,
	poToken,
});

console.log("\n");

// Create a new Innertube session with the generated tokens
innertube = await Innertube.create({
	po_token: poToken,
	visitor_data: visitorData,
	cache: new UniversalCache(),
	generate_session_locally: true,
});

// Fetch video information
const info = await innertube.getBasicInfo("F2Kg0ZUjbh0");

// Extract all available formats from the video information
const allFormats = info.streaming_data.adaptive_formats;

// Decipher URLs for all formats
const decipheredUrls = allFormats.map((format) => {
	try {
		// Decipher the format's URL using the session player
		const url = format.decipher(innertube.session.player);
		return { ...format, url };
	} catch (error) {
		console.error(`Error deciphering format ${format.itag}:`, error);
		return { format: format.itag, url: null };
	}
});

// Log all deciphered URLs
console.log("Deciphered URLs:", decipheredUrls);

// https://www.youtube.com/shorts/
