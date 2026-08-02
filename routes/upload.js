/**
 * routes/upload.js — Supabase Storage upload endpoints
 *
 * POST /upload/campaign-media  — admin: upload campaign images/videos
 * POST /upload/proof           — partner: upload proof screenshots
 *
 * Register in index.js:
 *   const uploadRouter = require('./routes/upload')
 *   app.use('/api', uploadRouter)
 */

const express    = require('express')
const router     = express.Router()
const jwt        = require('jsonwebtoken')
const { createClient } = require('@supabase/supabase-js')
const path       = require('path')
const ws         = require('ws')

// ── Supabase client ───────────────────────────────────────────
// Node.js 20 does not expose a global WebSocket by default.
// @supabase/supabase-js 2.109.0 requires ws to be supplied explicitly.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { global: { fetch: fetch, WebSocket: ws } }
)

// ── Auth helpers ──────────────────────────────────────────────
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1]
  if (!token) return res.status(401).json({ error: 'Unauthorized' })
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET)
    next()
  } catch {
    res.status(401).json({ error: 'Invalid token' })
  }
}

function adminAuth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1]
  if (!token) return res.status(401).json({ error: 'Unauthorized' })
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET)
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admins only' })
    next()
  } catch {
    res.status(401).json({ error: 'Invalid token' })
  }
}

// ── Raw body parser for file uploads ─────────────────────────
// Uses Node.js built-in — no multer dependency needed
const { Readable } = require('stream')

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const boundary = req.headers['content-type']?.split('boundary=')[1]
    if (!boundary) return reject(new Error('No boundary in content-type'))

    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      try {
        const body      = Buffer.concat(chunks)
        const delimiter = Buffer.from(`--${boundary}`)
        const parts     = []
        let start       = body.indexOf(delimiter) + delimiter.length + 2 // skip \r\n

        while (true) {
          const next = body.indexOf(delimiter, start)
          if (next === -1) break

          const part   = body.slice(start, next - 2) // trim \r\n before delimiter
          const sepIdx = part.indexOf('\r\n\r\n')
          if (sepIdx === -1) { start = next + delimiter.length + 2; continue }

          const headerStr = part.slice(0, sepIdx).toString()
          const fileData  = part.slice(sepIdx + 4)

          const nameMatch = headerStr.match(/name="([^"]+)"/)
          const fileMatch = headerStr.match(/filename="([^"]+)"/)
          const typeMatch = headerStr.match(/Content-Type:\s*([^\r\n]+)/i)

          parts.push({
            name:        nameMatch?.[1] || '',
            filename:    fileMatch?.[1] || '',
            contentType: typeMatch?.[1]?.trim() || 'application/octet-stream',
            data:        fileData,
          })

          start = next + delimiter.length + 2
        }

        resolve(parts)
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

// ── Unique filename ───────────────────────────────────────────
function uniqueFilename(originalName) {
  const ext  = path.extname(originalName || 'file').toLowerCase()
  const ts   = Date.now()
  const rand = Math.random().toString(36).slice(2, 8)
  return `${ts}-${rand}${ext}`
}

// ── POST /upload/campaign-media ───────────────────────────────
router.post('/upload/campaign-media', adminAuth, async (req, res) => {
  try {
    const contentType = req.headers['content-type'] || ''
    if (!contentType.includes('multipart/form-data')) {
      return res.status(400).json({ error: 'Must be multipart/form-data' })
    }

    const parts = await parseMultipart(req)
    const file  = parts.find(p => p.name === 'file' && p.filename)
    if (!file) return res.status(400).json({ error: 'No file provided' })

    const allowed = ['image/jpeg','image/png','image/webp','video/mp4','video/webm','video/quicktime']
    if (!allowed.includes(file.contentType)) {
      return res.status(400).json({ error: 'Unsupported file type' })
    }

    if (file.data.length > 50 * 1024 * 1024) {
      return res.status(400).json({ error: 'File too large. Maximum 50MB.' })
    }

    const filename    = uniqueFilename(file.filename)
    const storagePath = `campaigns/${filename}`

    const { error: uploadError } = await supabase.storage
      .from('campaign-media')
      .upload(storagePath, file.data, {
        contentType:  file.contentType,
        cacheControl: '3600',
        upsert:       false,
      })

    if (uploadError) {
      console.error('[upload/campaign-media]', uploadError)
      return res.status(500).json({ error: 'Upload failed: ' + uploadError.message })
    }

    const { data } = supabase.storage
      .from('campaign-media')
      .getPublicUrl(storagePath)

    res.json({ success: true, url: data.publicUrl, path: storagePath })
  } catch (e) {
    console.error('[upload/campaign-media]', e)
    res.status(500).json({ error: 'Server error: ' + e.message })
  }
})

// ── POST /upload/proof ────────────────────────────────────────
router.post('/upload/proof', auth, async (req, res) => {
  try {
    const contentType = req.headers['content-type'] || ''
    if (!contentType.includes('multipart/form-data')) {
      return res.status(400).json({ error: 'Must be multipart/form-data' })
    }

    const parts = await parseMultipart(req)
    const file  = parts.find(p => p.name === 'file' && p.filename)
    if (!file) return res.status(400).json({ error: 'No file provided' })

    if (!file.contentType.startsWith('image/')) {
      return res.status(400).json({ error: 'Proof must be an image file' })
    }

    if (file.data.length > 10 * 1024 * 1024) {
      return res.status(400).json({ error: 'File too large. Maximum 10MB.' })
    }

    const filename    = uniqueFilename(file.filename)
    const storagePath = `proofs/${req.user.userId}/${filename}`

    const { error: uploadError } = await supabase.storage
      .from('proof-uploads')
      .upload(storagePath, file.data, {
        contentType:  file.contentType,
        cacheControl: '3600',
        upsert:       false,
      })

    if (uploadError) {
      console.error('[upload/proof]', uploadError)
      return res.status(500).json({ error: 'Upload failed: ' + uploadError.message })
    }

    const { data, error: signError } = await supabase.storage
      .from('proof-uploads')
      .createSignedUrl(storagePath, 60 * 60 * 24)

    if (signError) {
      console.error('[upload/proof signed URL]', signError)
      return res.status(500).json({ error: 'Could not generate signed URL' })
    }

    res.json({ success: true, url: data.signedUrl, path: storagePath })
  } catch (e) {
    console.error('[upload/proof]', e)
    res.status(500).json({ error: 'Server error: ' + e.message })
  }
})

module.exports = router
