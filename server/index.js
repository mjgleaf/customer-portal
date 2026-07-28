import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { equipmentRouter } from './routes/equipment.js';
import { documentsRouter } from './routes/documents.js';
import { projectsRouter } from './routes/projects.js';
import { operationsRouter } from './routes/operations.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: process.env.CORS_ORIGIN || 'http://localhost:5173' }));
app.use(express.json());

// Health check
app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
});

// Routes
app.use('/api/portal/equipment', equipmentRouter);
app.use('/api/portal/documents', documentsRouter);
app.use('/api/portal/projects', projectsRouter);
app.use('/api/ops', operationsRouter);

app.listen(PORT, () => {
    console.log(`Portal API server running on http://localhost:${PORT}`);
});
