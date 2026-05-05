require('dotenv').config();
const mongoose = require('mongoose');
const app = require('./app');
const { start: startScheduler, stop: stopScheduler } = require('./engine/scheduler');

const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
  console.error('MONGO_URI is not defined in .env');
  process.exit(1);
}

if (!process.env.JWT_SECRET) {
  console.error('JWT_SECRET is not defined in .env');
  process.exit(2);
}

mongoose
  .connect(MONGO_URI)
  .then(() => {
    console.log('MongoDB connected');

    const server = app.listen(PORT, '0.0.0.0', () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });

    // Start the auto-signal engine
    startScheduler();

    // Graceful shutdown
    const shutdown = () => {
      console.log('\nShutting down...');
      stopScheduler();
      server.close(() => {
        mongoose.connection.close();
        process.exit(0);
      });
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT',  shutdown);
  })
  .catch((err) => {
    console.error('MongoDB connection error:', err.message);
    process.exit(1);
  });
