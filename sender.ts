import express from 'express'
import path from 'path'
import fs from 'fs'
import { Encoder } from "@toondepauw/node-zstd"

const app = express()
const port = 4000

app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// Serve static files from public folder (like sender.html, colorqr.html)
app.use(express.static('public'))

// In-memory store of file chunks
interface ChunkMap {
	[fileName: string]: string[]
}
const fileChunks: ChunkMap = {}

/**
 * POST /api/process
 * { folderPath: string }
 * Read/compress/chunk each file in folder. Return JSON with chunk counts.
 */
app.post('/api/process', (req, res) => {
	try {
		const folderPath = req.body.folderPath
		if (!folderPath || !fs.existsSync(folderPath)) {
			return res.status(400).json({ error: 'Invalid folder path.' })
		}

		const files = fs.readdirSync(folderPath)
		files.forEach((file) => {
			const filePath = path.join(folderPath, file)
			const fileBuffer = fs.readFileSync(filePath)
			const encoder = new Encoder(21)

			const compressed = encoder.encodeSync(fileBuffer)

			const chunkSize = 600
			const chunks: string[] = []
			for (let i = 0; i < compressed.length; i += chunkSize) {
				const slice = compressed.subarray(i, i + chunkSize)
				chunks.push(slice.toString('base64'))
			}
			fileChunks[file] = chunks
		})

		// Build result
		const output = files.map((f) => ({
			fileName: f,
			chunkCount: fileChunks[f].length
		}))
		res.json({ success: true, files: output })
	} catch (err) {
		console.error('[SERVER] Error processing folder:', err)
		res.status(500).json({ error: 'Server error processing folder' })
	}
})

/**
 * GET /colorqr/:fileName
 * We'll read colorqr.html, replace placeholders with real data, then send it.
 */
app.get('/colorqr/:fileName', (req, res) => {
	const fileName = req.params.fileName
	const chunks = fileChunks[fileName]
	if (!chunks) {
		return res.status(404).send('No chunks found for file: ' + fileName)
	}

	// Read the colorqr template
	const colorqrPath = path.join('public', 'colorqr.html')
	if (!fs.existsSync(colorqrPath)) {
		return res.status(500).send('colorqr.html not found in public folder.')
	}

	try {
		let html = fs.readFileSync(colorqrPath, 'utf8')
		// Replace placeholders
		html = html.replaceAll('@@FILE_NAME@@', fileName)
		html = html.replaceAll('@@CHUNKS@@', JSON.stringify(chunks))
		res.type('html').send(html)
	} catch (error) {
		console.error('[SERVER] Error reading colorqr.html:', error)
		res.status(500).send('Error reading colorqr.html template.')
	}
})

app.listen(port, () => {
	console.log(`[SERVER] Running at http://localhost:${port}`)
})
