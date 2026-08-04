import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import axios from 'axios';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const RENDER_URL = process.env.RENDER_URL || `https://cladd-server.onrender.com`;

// CORS - Allow all
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Static files
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${unique}-${file.originalname}`);
  }
});
const upload = multer({ 
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }
});

// ============ LLM Router ============
const LLM_PROVIDERS = [
  {
    name: 'GROQ',
    call: async (input, scene) => {
      const response = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          model: 'llama-3.1-70b-versatile',
          messages: [
            { role: 'system', content: getSystemPrompt() },
            { role: 'user', content: JSON.stringify({ input, scene }) }
          ],
          temperature: 0.3,
          response_format: { type: 'json_object' }
        },
        { 
          headers: { 
            'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
            'Content-Type': 'application/json'
          },
          timeout: 15000
        }
      );
      return JSON.parse(response.data.choices[0].message.content);
    }
  },
  {
    name: 'CEREBRAS',
    call: async (input, scene) => {
      const response = await axios.post(
        'https://api.cerebras.ai/v1/chat/completions',
        {
          model: 'llama3.1-70b',
          messages: [
            { role: 'system', content: getSystemPrompt() },
            { role: 'user', content: JSON.stringify({ input, scene }) }
          ],
          temperature: 0.3
        },
        { 
          headers: { 
            'Authorization': `Bearer ${process.env.CEREBRAS_API_KEY}`,
            'Content-Type': 'application/json'
          },
          timeout: 15000
        }
      );
      return JSON.parse(response.data.choices[0].message.content);
    }
  },
  {
    name: 'REPLICATE',
    call: async (input, scene) => {
      const response = await axios.post(
        'https://api.replicate.com/v1/predictions',
        {
          version: '2c1608e18606fad2812020dc541930f2d0495ce32eee50074220b87300bc16e1',
          input: {
            prompt: `${getSystemPrompt()}\n\nUser input: ${JSON.stringify({ input, scene })}`,
            max_tokens: 500,
            temperature: 0.3
          }
        },
        { 
          headers: { 
            'Authorization': `Token ${process.env.REPLICATE_API_TOKEN}`,
            'Content-Type': 'application/json'
          },
          timeout: 15000
        }
      );

      const predictionId = response.data.id;
      let result = null;
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 500));
        const status = await axios.get(
          `https://api.replicate.com/v1/predictions/${predictionId}`,
          { headers: { 'Authorization': `Token ${process.env.REPLICATE_API_TOKEN}` } }
        );
        if (status.data.status === 'succeeded') {
          result = status.data.output;
          break;
        }
        if (status.data.status === 'failed') break;
      }
      if (!result) throw new Error('Replicate timeout/failed');
      
      const jsonMatch = result.join('').match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON found in Replicate response');
      return JSON.parse(jsonMatch[0]);
    }
  }
];

function getSystemPrompt() {
  return `You are CLADD (Cognitive Lattice for Autonomous Display and Directive). You are a voice-first AI assistant. Always address the user as "BOSS". You have perfect memory of the 3D workspace.

Convert the user's voice or text command into JSON actions for a holographic 3D workspace. Only output valid JSON with an "actions" array and a "reply" string.

Available actions:
- create: { action: "create", type: "sphere|cube|cylinder|plane", position: [x,y,z], color: "#hex", scale: [x,y,z] }
- resize: { action: "resize", id: "object_id", scale: [x,y,z] }
- move: { action: "move", id: "object_id", position: [x,y,z] }
- rotate: { action: "rotate", id: "object_id", rotation: [x,y,z] }
- delete: { action: "delete", id: "object_id" }
- import_image: { action: "import_image", url: "string", position: [x,y,z], scale: [x,y,z] }
- show_hud: { action: "show_hud", message: "string" }

Return format: { "actions": [...], "reply": "string addressing BOSS" }

Example: For "create a red sphere at center", reply "Yes BOSS, creating a red sphere" and actions: [{"action":"create","type":"sphere","position":[0,0,0],"color":"#ff0000","scale":[1,1,1]}]`;
}

async function callLLM(input, scene) {
  let lastError = null;
  for (const provider of LLM_PROVIDERS) {
    try {
      console.log(`[LLM] Trying ${provider.name}...`);
      const result = await provider.call(input, scene);
      if (result.actions && result.reply) {
        console.log(`[LLM] Success with ${provider.name}`);
        return result;
      }
      throw new Error('Invalid response format');
    } catch (error) {
      lastError = error;
      console.error(`[LLM] ${provider.name} failed:`, error.message);
      if (error.response?.status === 429 || error.response?.status === 500) continue;
      if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) continue;
    }
  }
  throw new Error(`All LLM providers failed. Last error: ${lastError?.message || 'Unknown'}`);
}

// ============ Routes ============

app.get('/health', (req, res) => {
  console.log(`[${new Date().toISOString()}] GET /health`);
  res.json({ status: 'ok' });
});

// THIS IS THE MISSING ENDPOINT - App calls GET /scene on startup
app.get('/scene', (req, res) => {
  console.log(`[${new Date().toISOString()}] GET /scene - Loading default workspace`);
  res.json({
    objects: [
      { id: "grid_default", type: "plane", color: "#003366", position: [0, 0, -5], scale: [4, 4, 1], rotation: [0, 0, 0] },
      { id: "sphere_01", type: "sphere", color: "#00FFFF", position: [-80, -40, 0], scale: [1, 1, 1], rotation: [0, 0, 0] },
      { id: "cube_01", type: "cube", color: "#FF00FF", position: [80, -40, 10], scale: [1, 1, 1], rotation: [0, 0, 0] },
      { id: "cube_02", type: "cube", color: "#FFFF00", position: [0, 60, 0], scale: [0.8, 0.8, 0.8], rotation: [0, 0, 0] }
    ]
  });
});

app.get('/ping', (req, res) => {
  console.log(`[${new Date().toISOString()}] GET /ping`);
  res.json({ status: 'awake', message: 'Yes BOSS, CLADD is online' });
});

app.post('/command', async (req, res, next) => {
  console.log(`[${new Date().toISOString()}] POST /command - input: "${req.body.input?.substring(0, 50)}..."`);
  try {
    const { input, scene = [] } = req.body;
    if (!input || typeof input !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid "input" field' });
    }

    const result = await callLLM(input, scene);
    console.log(`[LLM] Reply: "${result.reply}"`);
    res.json(result);
  } catch (error) {
    console.error('[Command Error]', error.message);
    res.status(500).json({ 
      actions: [],
      reply: "Sorry BOSS, I encountered an error processing that command."
    });
  }
});

app.post('/import', upload.single('image'), (req, res, next) => {
  console.log(`[${new Date().toISOString()}] POST /import - file: ${req.file?.originalname}`);
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image file uploaded' });
    }

    const fileUrl = `${RENDER_URL}/uploads/${req.file.filename}`;

    res.json({
      action: 'import_image',
      url: fileUrl,
      filename: req.file.filename,
      size: req.file.size
    });
  } catch (error) {
    next(error);
  }
});

app.post('/export', (req, res, next) => {
  console.log(`[${new Date().toISOString()}] POST /export`);
  try {
    const { scene = [] } = req.body;
    if (!Array.isArray(scene)) {
      return res.status(400).json({ error: 'Scene must be an array' });
    }

    // Save to uploads folder
    const exportFilename = `export-${Date.now()}.json`;
    const exportPath = path.join(uploadsDir, exportFilename);
    fs.writeFileSync(exportPath, JSON.stringify(scene, null, 2));
    
    const downloadUrl = `${RENDER_URL}/uploads/${exportFilename}`;
    console.log(`[Export] Saved to: ${downloadUrl}`);
    
    res.json({
      download_url: downloadUrl,
      message: 'Export generated successfully'
    });
  } catch (error) {
    next(error);
  }
});

// Error handler
app.use((err, req, res, next) => {
  console.error('[Error]', err.message);
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.message });
  }
  const status = err.status || 500;
  res.status(status).json({ 
    error: err.message || 'Internal server error'
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`CLADD Server running on port ${PORT}`);
  console.log(`Health: ${RENDER_URL}/health`);
  console.log(`Scene: ${RENDER_URL}/scene`);
});
