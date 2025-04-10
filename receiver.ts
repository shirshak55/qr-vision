import express from 'express'
import cors from 'cors'
import multer from 'multer'
import ffmpeg from 'fluent-ffmpeg'
import { promises as fsPromises } from 'fs'
import path from 'path'
import zlib from 'zlib'
import pLimit from 'p-limit'
import { createCanvas, loadImage } from 'canvas'
// Use jsQR for QR decoding
import jsQR from 'jsqr'
import { Decoder } from "@toondepauw/node-zstd"

const app = express()
const port = 4001

app.use(express.json())
app.use(cors())
app.use(express.static('public'))

// For file uploads
const upload = multer({ dest: 'uploads/' })

// Store chunks for a single file
// If you're handling multiple files, you'd need to expand this approach.
let totalChunks = 0
const chunks: { [index: number]: string } = {}

////////////////////////////////////////////////////////////////////////
// (1) Extract frames from video at 1 frame per second
////////////////////////////////////////////////////////////////////////
function extractFrames(videoPath: string, framesDir: string): Promise<void> {
	return new Promise((resolve, reject) => {
		console.log('[RECEIVER] Extracting frames...')
		ffmpeg(videoPath)
			.outputOptions('-vf', 'fps=1') // 1 frame per second
			.outputOptions('-qscale:v', '2')
			.output(path.join(framesDir, 'frame-%03d.png'))
			.on('end', () => {
				console.log('[RECEIVER] Frame extraction complete.')
				resolve()
			})
			.on('error', (err) => {
				console.error('[RECEIVER] Error extracting frames:', err)
				reject(err)
			})
			.run()
	})
}

////////////////////////////////////////////////////////////////////////
// (2) Decode a single frame for a QR code using jsQR
////////////////////////////////////////////////////////////////////////
async function decodeQRCodeFromImage(filePath: string): Promise<string | null> {
	try {
		const img = await loadImage(filePath)
		const canvas = createCanvas(img.width, img.height)
		const ctx = canvas.getContext('2d')
		ctx.drawImage(img, 0, 0)

		const imageData = ctx.getImageData(0, 0, img.width, img.height)
		const code = jsQR(imageData.data, img.width, img.height)

		// Return decoded text if found
		return code?.data || null
	} catch {
		return null
	}
}

////////////////////////////////////////////////////////////////////////
// (3) Process frames in parallel, decode chunk data
////////////////////////////////////////////////////////////////////////
async function processFrames(framesDir: string): Promise<void> {
	const files = await fsPromises.readdir(framesDir)
	const limit = pLimit(5) // decode up to 5 frames concurrently

	console.log('[RECEIVER] Found frames:', files.length)

	// Decode each frame’s QR in parallel (up to 5 at a time)
	const decodeResults = await Promise.all(
		files.map((file) =>
			limit(async () => {
				const filePath = path.join(framesDir, file)
				const text = await decodeQRCodeFromImage(filePath)
				if (!text) {
					console.warn('[RECEIVER] No valid QR in frame:', file)
					return null
				}
				return { file, text }
			})
		)
	)

	// Filter out frames that had no valid QR code
	const validFrames = decodeResults.filter((r) => r && r.text) as Array<{
		file: string
		text: string
	}>

	// Parse and store chunk data
	for (const frameResult of validFrames) {
		const { text } = frameResult

		// Expect the format: "index||totalChunks||chunkData"
		const parts = text.split('||')
		if (parts.length !== 3) {
			console.warn('[RECEIVER] Ignoring malformed chunk:', text)
			continue
		}

		const [indexStr, totalStr, chunkData] = parts
		const index = parseInt(indexStr, 10)
		const total = parseInt(totalStr, 10)

		// Make sure the numeric parts are valid
		if (
			Number.isNaN(index) ||
			Number.isNaN(total) ||
			!chunkData ||
			chunkData.length === 0
		) {
			console.warn('[RECEIVER] Invalid chunk data:', text)
			continue
		}

		// Keep track of totalChunks from any valid chunk
		if (totalChunks === 0) {
			totalChunks = total
		} else if (totalChunks !== total) {
			console.warn(
				`[RECEIVER] Mismatch in declared totalChunks (was ${totalChunks}, got ${total})`
			)
		}

		// Only store the chunk if it's new or longer than an existing one
		const existing = chunks[index]
		if (!existing || chunkData.length > existing.length) {
			chunks[index] = chunkData
		} else {
			// console.warn(`[RECEIVER] Duplicate chunk index ${index} ignored.`)
		}
	}
}

////////////////////////////////////////////////////////////////////////
// (4) Attempt to rebuild the file from the collected chunks
////////////////////////////////////////////////////////////////////////
async function assembleFile(): Promise<{
	success: boolean
	missingChunks: number[]
	path?: string
	error?: string
}> {
	if (totalChunks === 0) {
		return {
			success: false,
			missingChunks: [],
			error: 'No valid chunks found at all.'
		}
	}

	// Identify which chunks are still missing
	const missingChunks: number[] = []
	for (let i = 0; i < totalChunks; i++) {
		if (!chunks[i]) {
			missingChunks.push(i)
		}
	}

	if (missingChunks.length > 0) {
		return {
			success: false,
			missingChunks,
			error: `Missing chunks: ${missingChunks.join(', ')}`
		}
	}

	try {
		// Concatenate chunk data in correct order
		const ordered = []
		for (let i = 0; i < totalChunks; i++) {
			ordered.push(chunks[i])
		}

		// Base64 → Buffer → gunzip
		const compressedBuffer = Buffer.from(ordered.join(''), 'base64')

		let decoder = new Decoder()
		const original = decoder.decodeSync(compressedBuffer)

		const outPath = 'reconstructed_file'
		await fsPromises.writeFile(outPath, original)

		console.log('[RECEIVER] Wrote reassembled file to', outPath)
		return { success: true, missingChunks: [], path: outPath }
	} catch (err: any) {
		console.error('[RECEIVER] Decompression error:', err)
		return { success: false, missingChunks: [], error: err.message }
	}
}

////////////////////////////////////////////////////////////////////////
// (5) Final route: upload a video, process frames, assemble file
////////////////////////////////////////////////////////////////////////
app.post('/upload-video', upload.single('video'), async (req, res) => {
	if (!req.file) {
		return res.status(400).send('No video file provided.')
	}

	// Reset chunk storage for each upload
	totalChunks = 0
	for (const key in chunks) delete chunks[key]

	// Use the original filename (without extension) for the frames directory
	const fileBaseName = path.parse(req.file.originalname).name
	const framesDir = path.join('frames', fileBaseName)

	console.log('[RECEIVER] Got video:', req.file.originalname)
	console.log('[RECEIVER] Using frames directory:', framesDir)

	// If the directory exists, remove it; then recreate it
	await fsPromises.rm(framesDir, { recursive: true, force: true })
	await fsPromises.mkdir(framesDir, { recursive: true })

	try {
		// 1) Extract frames
		await extractFrames(req.file.path, framesDir)

		// 2) Process frames for QR codes
		await processFrames(framesDir)

		// 3) Attempt to assemble
		const result = await assembleFile()

		// Return JSON summary
		res.json({ success: result.success, ...result })
	} catch (err: any) {
		console.error('[RECEIVER] Error handling video:', err)
		res.status(500).send('Error processing video: ' + err.message)
	}
})

// Optional: check chunk status
app.get('/status', (req, res) => {
	const receivedChunks = Object.keys(chunks).length
	res.json({
		totalChunks,
		receivedChunks,
		missingChunks: [...Array(totalChunks).keys()].filter((i) => !chunks[i])
	})
})

// Simple health check route
app.get('/', (req, res) => {
	res.send('<h1>Receiver is running. POST a video to /upload-video</h1>')
})

// Start up
app.listen(port, () => {
	console.log(`[RECEIVER] Listening on port ${port}`)
})
