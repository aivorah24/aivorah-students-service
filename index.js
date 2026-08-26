require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'aivorah-students-service' }));

app.use('/teacher', require('./routes/teacher'));
app.use('/student', require('./routes/student'));

const PORT = process.env.PORT || 3017;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Aivorah Students service running on http://localhost:${PORT}`);
  });
}

module.exports = app;
