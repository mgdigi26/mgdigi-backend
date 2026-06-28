const express = require('express')
const cors = require('cors')
require('dotenv').config()

const app = express()
app.use(cors())
app.use(express.json())

// Routes
app.use('/api/auth', require('./routes/auth'))
app.use('/api/dashboard', require('./routes/dashboard'))
app.use('/api/campaigns', require('./routes/campaigns'))
app.use('/api/submissions', require('./routes/submissions'))
app.use('/api/wallet', require('./routes/wallet'))
app.use('/api/withdrawals', require('./routes/withdrawals'))
app.use('/api/team', require('./routes/team'))
app.use('/api/admin', require('./routes/admin'))

const PORT = process.env.PORT || 3001
app.listen(PORT, () => {
  console.log(`MGdigi backend running on port ${PORT}`)
})