// The player's entry point into the game: pick or drop a photo. Turns whatever they choose into a
// real ImageBitmap, the same shape core/ingestImage expects downstream, and hands it to onImage.
// Deliberately bare, no cozy dressing yet, see docs/phase8.md's B and C sections for the wooden table
// this will eventually sit on top of. Colours borrowed from docs/art-direction.md's starting palette
// rather than invented, so this does not fight the real thing once it exists.

export interface UploadZone {
  element: HTMLElement
}

export function createUploadZone(onImage: (image: ImageBitmap, file: File) => void): UploadZone {
  const container = document.createElement('div')
  container.id = 'upload-zone'
  container.style.cssText = `
    position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
    font: 16px system-ui, sans-serif; color: #4A443C; cursor: pointer;
  `

  const box = document.createElement('div')
  box.style.cssText = `
    border: 2px dashed #C9BCA6; border-radius: 12px; padding: 48px 64px; text-align: center;
    background: #EDE6DA;
  `
  box.textContent = 'Click or drop a photo to begin'

  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  input.style.display = 'none'

  container.append(box, input)

  async function handleFile(file: File | undefined): Promise<void> {
    if (!file) return

    if (!file.type.startsWith('image/')) {
      box.textContent = `${file.name} is not an image, try another file`
      return
    }

    try {
      const image = await createImageBitmap(file)
      onImage(image, file)
    } catch {
      box.textContent = `could not read ${file.name}, try another file`
    }
  }

  container.addEventListener('click', () => input.click())
  input.addEventListener('change', () => { void handleFile(input.files?.[0]) })

  container.addEventListener('dragover', (event) => {
    event.preventDefault()
    box.style.borderColor = '#C88B6A'
  })
  container.addEventListener('dragleave', () => {
    box.style.borderColor = '#C9BCA6'
  })
  container.addEventListener('drop', (event) => {
    event.preventDefault()
    box.style.borderColor = '#C9BCA6'
    void handleFile(event.dataTransfer?.files?.[0])
  })

  return { element: container }
}
