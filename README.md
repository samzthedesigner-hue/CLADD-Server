# CLADD - Cognitive Lattice for Autonomous Display and Directive

An on-command cloud AI that runs on Android 15, featuring a holographic 3D workspace display engine with 100 AI personalities mapped to generic feature commands.

## Architecture

- **Android App**: Native Java application for Android 15 (minSdk 35)
- **Backend Server**: Node.js with Express, routing to multiple LLM providers
- **LLM Priority**: 1. GROQ Llama 3.1 70B → 2. Cerebras Llama 3.1 70B → 3. Replicate Llama 3.1 70B

## Features

- 🎤 Voice command recognition
- 📝 Text command input
- 🌐 Holographic wireframe rendering
- 🎨 Neon glow effects (cyan, magenta, yellow)
- 📊 3D primitive objects (sphere, cube, plane)
- 🖼️ Image import from files
- 📡 HUD overlays (radar, diagnostics, targeting)
- 🔊 Text-to-speech responses
- 🔄 Auto-retry with 3 LLM providers
- 🎯 Gesture-based 3D rotation

## Setup

### Android App

1. Open project in Android Studio
2. Set minSdk to 35 in build.gradle
3. Configure network security for cleartext traffic (development)
4. Update `NetworkService.java` BASE_URL to your server address
5. Build and run on Android 15 device/emulator

### Backend Server

1. Navigate to `server/` directory
2. Run `npm install`
3. Copy `.env.example` to `.env`
4. Add your API keys for at least one LLM provider
5. Start server: `npm start` or `npm run dev`

## API Endpoints

### POST /command
Process user commands through LLM
```json
{
  "input": "Create a blue sphere",
  "scene": []
}
