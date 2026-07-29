/**
 * routes/upload.js — Supabase Storage upload endpoints
 *
 * Provides two signed upload endpoints:
 *   POST /upload/campaign-media   → campaign images and videos (admin only)
 *   POST /upload/proof            → proof screenshots (partner only)
 *
 * Both endpoints:
 *   - Accept multipart/form-data with a single `file` field
 *   - Upload to the appropriate Supabase Storage bucket
 *   - Return a public URL
 *
 * Buckets required in Supabase Storage:
 *   campaign-media   — public read, authenticated write
 *   proof-uploads    — authenticated read + write
 *
 * Registration in index.js:
 *   const uploadRouter = require('./routes/upload')
 *   app.use('/api', uploadRouter)
 *
 * Dependencies:
 *   npm install @supabase/supabase-js multer
 */

const express    = require('express')
const router     = express.Router()
const multer     = require('multer')
const jwt        = require('jsonwebtoken')
const { createClient } = require('@supabase/supabase-js')
const path       = require('path')

// ── Supabase client (service-role key for server-side uploads) ─
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY   // service-role bypasses RLS for uploads
)

// ── Multer: memory storage (no disk writes on server) ─────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 50 * 1024 * 1024 }, // 50 MB max
  fileFilter(req, file, cb) {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm', 'video/quicktime']
    if (allowed.includes(file.mimetype)) {
      cb(null, true)
    } else {
      cb(new Error('Unsupported file type. Allowed: JPEG, PNG, WebP, MP4, WebM, MOV'))
    }
  }
})

// ── Auth helpers ───────────────────────────────────────────────
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

// ── Unique filename generator ──────────────────────────────────
function uniqueFilename(originalName) {
  const ext  = path.extname(originalName).toLowerCase()
  const ts   = Date.now()
  const rand = Math.random().toString(36).slice(2, 8)
  return `${ts}-${rand}${ext}`
}

// ── POST /upload/campaign-media ────────────────────────────────
/**
 * Upload a campaign image or video (admin only).
 * Accepts:  multipart/form-data { file }
 * Returns:  { success: true, url: string, path: string }
 *
 * The returned `url` is a public URL suitable for storing in
 * CampaignSchedule.imageUrl or CampaignSchedule.videoUrl.
 */
router.post('/upload/campaign-media', adminAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' })

    const filename    = uniqueFilename(req.file.originalname)
    const storagePath = `campaigns/${filename}`

    const { error: uploadError } = await supabase.storage
      .from('campaign-media')
      .upload(storagePath, req.file.buffer, {
        contentType:  req.file.mimetype,
        cacheControl: '3600',
        upsert:       false,
      })

    if (uploadError) {
      console.error('[upload/campaign-media]', uploadError)
      return res.status(500).json({ error: 'Upload failed: ' + uploadError.message })
    }

    // Get public URL (bucket must be public in Supabase dashboard)
    const { data } = supabase.storage
      .from('campaign-media')
      .getPublicUrl(storagePath)

    res.json({ success: true, url: data.publicUrl, path: storagePath })
  } catch (e) {
    console.error('[upload/campaign-media]', e)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── POST /upload/proof ─────────────────────────────────────────
/**
 * Upload a proof screenshot (partner only).
 * Accepts:  multipart/form-data { file }
 * Returns:  { success: true, url: string, path: string }
 *
 * The returned `url` should be stored in CampaignEnrollment.screenshotUrl
 * via the existing POST /schedule/:id/submit endpoint.
 *
 * Proof uploads are stored under proofs/{userId}/{filename} so each
 * partner's proofs are isolated by userId.
 */
router.post('/upload/proof', auth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' })

    // Only images accepted for proofs
    if (!req.file.mimetype.startsWith('image/')) {
      return res.status(400).json({ error: 'Proof must be an image file' })
    }

    const filename    = uniqueFilename(req.file.originalname)
    const storagePath = `proofs/${req.user.userId}/${filename}`

    const { error: uploadError } = await supabase.storage
      .from('proof-uploads')
      .upload(storagePath, req.file.buffer, {
        contentType:  req.file.mimetype,
        cacheControl: '3600',
        upsert:       false,
      })

    if (uploadError) {
      console.error('[upload/proof]', uploadError)
      return res.status(500).json({ error: 'Upload failed: ' + uploadError.message })
    }

    // Signed URL (24-hour expiry) — proof-uploads bucket is private
    const { data, error: signError } = await supabase.storage
      .from('proof-uploads')
      .createSignedUrl(storagePath, 60 * 60 * 24) // 24 hours

    if (signError) {
      console.error('[upload/proof signed URL]', signError)
      return res.status(500).json({ error: 'Could not generate signed URL' })
    }

    res.json({ success: true, url: data.signedUrl, path: storagePath })
  } catch (e) {
    console.error('[upload/proof]', e)
    res.status(500).json({ error: 'Server error' })
  }
})

module.exports = router
