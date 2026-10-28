/**
 * MongoDB connection singleton.
 * Call connect() once at startup; all models reuse the same connection.
 */
import mongoose from 'mongoose';

let connectionPromise = null;

/**
 * Connect to MongoDB. Safe to call multiple times — returns the cached promise.
 * @param {string} [uri]
 * @returns {Promise<mongoose.Connection>}
 */
export async function connect(uri) {
  if (connectionPromise) return connectionPromise;

  const mongoUri = uri || process.env.MONGODB_URI || 'mongodb://localhost:27017/repolens';

  connectionPromise = mongoose
    .connect(mongoUri, {
      serverSelectionTimeoutMS: 10_000,
    })
    .then((m) => m.connection)
    .catch((err) => {
      connectionPromise = null; // allow retry on next call
      throw new Error(`MongoDB connection failed: ${err.message}`);
    });

  return connectionPromise;
}

/**
 * Disconnect — used in tests or graceful shutdown.
 */
export async function disconnect() {
  connectionPromise = null;
  await mongoose.disconnect();
}

export default mongoose;
