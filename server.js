require('dotenv').config();

const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const vitalsRoutes = require('./routes/vitalsRoutes');

const app = express();
const isProduction = process.env.NODE_ENV === 'production';

// Localhost by default so the dashboard isn't visible to the rest of the network.
// Set HOST=0.0.0.0 in .env to open it to other devices on the LAN.
const PORT = Number(process.env.PORT) || 3141;
const HOST = process.env.HOST || '127.0.0.1';

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        // Plain HTTP on the LAN, so only upgrade requests in production
        upgradeInsecureRequests: isProduction ? [] : null,
      },
    },
  })
);
app.use(morgan(isProduction ? 'combined' : 'dev'));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/', vitalsRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).render('error', {
    title: 'Not found',
    message: 'That page does not exist.',
  });
});

// Error handler: log everything, show users a generic message
app.use((err, req, res, next) => {
  console.error(err);
  const status = err.status || 500;
  if (req.path.startsWith('/api/')) {
    return res.status(status).json({ error: 'Could not read vitals.' });
  }
  res.status(status).render('error', {
    title: 'Something went wrong',
    message: 'The server hit an error. Try again in a moment.',
  });
});

app.listen(PORT, HOST, () => {
  console.log(`Pi Vitals running at http://${HOST}:${PORT}`);
});
