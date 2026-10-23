import mongoose from 'mongoose';
import { env } from './env.js';
import { models } from '../models/index.js';
export async function connectDatabase() {
  await mongoose.connect(env.MONGODB_URI, { autoIndex: false, serverSelectionTimeoutMS: 10000 });
  const hello = await mongoose.connection.db!.admin().command({ hello: 1 });
  if (!hello.setName && hello.msg !== 'isdbgrid') {
    await mongoose.disconnect();
    throw new Error(
      'MongoDB replica set or sharded cluster required; standalone MongoDB cannot safely run financial and booking transactions',
    );
  }
  for (const model of Object.values(models)) await model.createIndexes();
}
