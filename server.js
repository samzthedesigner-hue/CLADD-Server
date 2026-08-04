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

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
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

// ============ PERSISTENT MEMORY SYSTEM ============
const sessionMemory = new Map();
const MEMORY_DIR = path.join(__dirname, 'memory');

if (!fs.existsSync(MEMORY_DIR)) {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
}

function getMemoryFilePath(sessionId) {
    return path.join(MEMORY_DIR, `${sessionId}.json`);
}

function loadMemoryFromDisk(sessionId) {
    try {
        const filePath = getMemoryFilePath(sessionId);
        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, 'utf8');
            const memory = JSON.parse(data);
            sessionMemory.set(sessionId, memory);
            console.log(`[Memory] Loaded ${memory.length} messages for session ${sessionId.substring(0, 8)}...`);
            return memory;
        }
    } catch (error) {
        console.error(`[Memory] Failed to load session ${sessionId}:`, error.message);
    }
    return [];
}

function saveMemoryToDisk(sessionId) {
    try {
        const memory = sessionMemory.get(sessionId);
        if (memory && memory.length > 0) {
            const filePath = getMemoryFilePath(sessionId);
            fs.writeFileSync(filePath, JSON.stringify(memory, null, 2));
        }
    } catch (error) {
        console.error(`[Memory] Failed to save session ${sessionId}:`, error.message);
    }
}

function getMemory(sessionId) {
    if (!sessionId) return [];
    
    if (!sessionMemory.has(sessionId)) {
        const loaded = loadMemoryFromDisk(sessionId);
        sessionMemory.set(sessionId, loaded);
    }
    return sessionMemory.get(sessionId);
}

function addToMemory(sessionId, role, content) {
    if (!sessionId) return;
    
    const memory = getMemory(sessionId);
    memory.push({
        role,
        content,
        timestamp: new Date().toISOString()
    });
    
    if (memory.length > 100) {
        memory.splice(0, memory.length - 100);
    }
    
    saveMemoryToDisk(sessionId);
}

// Clean old sessions every hour (inactive > 24 hours)
setInterval(() => {
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    try {
        const files = fs.readdirSync(MEMORY_DIR);
        for (const file of files) {
            const filePath = path.join(MEMORY_DIR, file);
            const stats = fs.statSync(filePath);
            if (stats.mtimeMs < oneDayAgo) {
                fs.unlinkSync(filePath);
                const sessionId = file.replace('.json', '');
                sessionMemory.delete(sessionId);
                console.log(`[Memory] Cleaned old session: ${sessionId.substring(0, 8)}...`);
            }
        }
    } catch (error) {
        console.error('[Memory] Cleanup error:', error.message);
    }
}, 60 * 60 * 1000);

// ============ LLM Router ============
const LLM_PROVIDERS = [
    {
        name: 'GROQ',
        call: async (messages) => {
            const response = await axios.post(
                'https://api.groq.com/openai/v1/chat/completions',
                {
                    model: 'llama-3.1-70b-versatile',
                    messages: messages,
                    temperature: 0.5,
                    max_tokens: 1000,
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
        call: async (messages) => {
            const response = await axios.post(
                'https://api.cerebras.ai/v1/chat/completions',
                {
                    model: 'llama3.1-70b',
                    messages: messages,
                    temperature: 0.5,
                    max_tokens: 1000
                },
                { 
                    headers: { 
                        'Authorization': `Bearer ${process.env.CEREBRAS_API_KEY}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 15000
                }
            );
            const content = response.data.choices[0].message.content;
            const jsonMatch = content.match(/\{[\s\S]*\}/);
            if (jsonMatch) return JSON.parse(jsonMatch[0]);
            throw new Error('No JSON found in response');
        }
    },
    {
        name: 'REPLICATE',
        call: async (messages) => {
            const prompt = messages.map(m => `${m.role}: ${m.content}`).join('\n');
            const response = await axios.post(
                'https://api.replicate.com/v1/predictions',
                {
                    version: '2c1608e18606fad2812020dc541930f2d0495ce32eee50074220b87300bc16e1',
                    input: {
                        prompt: prompt,
                        max_tokens: 1000,
                        temperature: 0.5
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
            if (jsonMatch) return JSON.parse(jsonMatch[0]);
            throw new Error('No JSON found in Replicate response');
        }
    }
];

function getSystemPrompt() {
    return `You are CLADD (Cognitive Lattice for Autonomous Display and Directive). You are a voice-first AI assistant with PERFECT persistent memory. You remember EVERYTHING discussed in this session. Never say "I don't remember" or "as I mentioned before" because you have access to the full conversation history.

Always address the user as "BOSS". Speak naturally and conversationally since your responses will be spoken via text-to-speech. Keep replies concise but warm and personal.

You control a holographic 3D workspace. When BOSS asks you to create or manipulate objects, output JSON actions. Available actions:
- create: {"action":"create","type":"sphere|cube|plane","position":[x,y,z],"color":"#hex","scale":1.0}
- resize: {"action":"resize","target_id":"uuid","scale":1.5}
- move: {"action":"move","target_id":"uuid","position":[x,y,z]}
- rotate: {"action":"rotate","target_id":"uuid","rotation":[x,y,z]}
- delete: {"action":"delete","target_id":"uuid"}
- import_image: {"action":"import_image","url":"string"}
- show_hud: {"action":"show_hud","type":"radar|diagnostics|targeting"}

Always output valid JSON: {"actions":[...], "reply":"Your spoken response to BOSS"}

If BOSS references something from earlier in the conversation, acknowledge it naturally. You have access to the full conversation history. Use it to be helpful, personal, and contextually aware.`;
}

async function callLLM(input, scene, sessionId) {
    const memory = getMemory(sessionId);
    
    const messages = [
        { role: 'system', content: getSystemPrompt() }
    ];
    
    if (memory.length > 0) {
        const recentMemory = memory.slice(-20);
        messages.push({
            role: 'system',
            content: `Previous conversation history (you remember ALL of this):\n${recentMemory.map(m => `${m.role}: ${m.content}`).join('\n')}`
        });
    }
    
    messages.push({
        role: 'user',
        content: `Current scene: ${JSON.stringify(scene)}\n\nBOSS says: ${input}`
    });

    let lastError = null;
    for (const provider of LLM_PROVIDERS) {
        if (!process.env.GROQ_API_KEY && provider.name === 'GROQ') continue;
        if (!process.env.CEREBRAS_API_KEY && provider.name === 'CEREBRAS') continue;
        if (!process.env.REPLICATE_API_TOKEN && provider.name === 'REPLICATE') continue;
        
        try {
            console.log(`[LLM] Trying ${provider.name}...`);
            const result = await provider.call(messages);
            if (result && result.reply) {
                console.log(`[LLM] Success with ${provider.name}: "${result.reply.substring(0, 80)}..."`);
                return result;
            }
            throw new Error('Invalid response format');
        } catch (error) {
            lastError = error;
            console.error(`[LLM] ${provider.name} failed:`, error.message);
        }
    }
    throw new Error(`All LLM providers failed. Last error: ${lastError?.message || 'Unknown'}`);
}

// ============ Routes ============

app.get('/health', (req, res) => {
    console.log(`[${new Date().toISOString()}] GET /health`);
    res.json({ status: 'ok', memory_sessions: sessionMemory.size });
});

app.get('/scene', (req, res) => {
    console.log(`[${new Date().toISOString()}] GET /scene`);
    res.json({
        objects: [
            { id: "grid_default", type: "plane", color: "#003366", position: [0, 0, -5], scale: [4, 4, 1], rotation: [0, 0, 0] },
            { id: "sphere_01", type: "sphere", color: "#00FFFF", position: [-80, -40, 0], scale: [1, 1, 1], rotation: [0, 0, 0] },
            { id: "cube_01", type: "cube", color: "#FF00FF", position: [80, -40, 10], scale: [1, 1, 1], rotation: [0, 0, 0] },
            { id: "cube_02", type: "cube", color: "#FFFF00", position: [0, 60, 0], scale: [0.8, 0.8, 0.8], rotation: [0, 0, 0] }
        ]
    });
});

app.post('/command', async (req, res) => {
    console.log(`[${new Date().toISOString()}] POST /command`);
    try {
        const { input, scene = [], session_id } = req.body;
        
        if (!input || typeof input !== 'string') {
            return res.status(400).json({ error: 'Missing "input"' });
        }

        if (session_id) {
            addToMemory(session_id, 'user', input);
        }

        const result = await callLLM(input, scene, session_id);
        
        if (session_id && result.reply) {
            addToMemory(session_id, 'assistant', result.reply);
        }

        console.log(`[LLM] Reply: "${result.reply?.substring(0, 80)}..."`);
        res.json(result);
    } catch (error) {
        console.error('[Command Error]', error.message);
        res.status(500).json({ 
            actions: [],
            reply: "Sorry BOSS, I encountered an error. Please try again."
        });
    }
});

app.post('/import', upload.single('image'), (req, res) => {
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
        res.status(500).json({ error: 'Import failed' });
    }
});

app.post('/export', (req, res) => {
    console.log(`[${new Date().toISOString()}] POST /export`);
    try {
        const { scene = [] } = req.body;
        if (!Array.isArray(scene)) {
            return res.status(400).json({ error: 'Scene must be an array' });
        }

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
        res.status(500).json({ error: 'Export failed' });
    }
});

app.get('/memory/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const memory = getMemory(sessionId);
    res.json({ sessionId, messageCount: memory.length, memory });
});

app.delete('/memory/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    sessionMemory.delete(sessionId);
    const filePath = getMemoryFilePath(sessionId);
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
    }
    res.json({ status: 'deleted', sessionId });
});

app.use((err, req, res, next) => {
    console.error('[Error]', err.message);
    res.status(500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`CLADD Server running on port ${PORT}`);
    console.log(`Health: ${RENDER_URL}/health`);
    console.log(`Scene: ${RENDER_URL}/scene`);
    console.log(`Memory storage: ${MEMORY_DIR}`);
    console.log('Persistent memory: ENABLED (sessions saved to disk)');
});
