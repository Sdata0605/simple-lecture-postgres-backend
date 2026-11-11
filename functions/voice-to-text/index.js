// Port of supabase/functions/voice-to-text. The original is a placeholder that returns a fixed
// transcription; it is kept as-is until a speech-to-text provider is chosen. POST { audioBase64 }.
import express from "express";

export const router = express.Router();

router.post("/", (req, res) => {
  try {
    // Mock transcription - in production, use OpenAI Whisper API
    const mockTranscription = "What is the formula for kinetic energy?";
    return res.json({ text: mockTranscription });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
    return res.status(500).json({ error: errorMessage });
  }
});

export default router;
