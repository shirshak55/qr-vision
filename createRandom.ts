import { writeFile } from 'fs/promises'

// Generates a random word with length between minLength and maxLength.
function randomWord(minLength = 3, maxLength = 10) {
	const length = Math.floor(Math.random() * (maxLength - minLength + 1)) + minLength
	const characters = 'abcdefghijklmnopqrstuvwxyz'
	let word = ''
	for (let i = 0; i < length; i++) {
		word += characters.charAt(Math.floor(Math.random() * characters.length))
	}
	return word
}

// Generates a single line with a random number of words (between 5 and 15 words).
function generateRandomLine() {
	const wordsPerLine = Math.floor(Math.random() * 11) + 5 // Random number between 5 and 15
	const words = []
	for (let i = 0; i < wordsPerLine; i++) {
		words.push(randomWord())
	}
	return words.join(' ')
}

async function generateRandomFile() {
	const fileName = 'random_text.txt'
	const targetSize = 1 * 1024 * 1024  // 1 MB of characters
	let text = ''

	// Build text until we reach the target size.
	while (text.length < targetSize) {
		text += generateRandomLine() + '\n'
	}

	// Trim any extra characters if we exceed the target size.
	if (text.length > targetSize) {
		text = text.slice(0, targetSize)
	}

	try {
		await writeFile(fileName, text)
		console.log(`Generated ${fileName} with approximately ${targetSize} random characters.`)
	} catch (error) {
		console.error('Error generating random text:', error)
	}
}

generateRandomFile()
