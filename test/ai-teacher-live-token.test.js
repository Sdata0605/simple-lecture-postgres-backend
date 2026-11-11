import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toBidiSetup } from "../functions/ai-teacher/index.js";

// Regression: the auth_tokens REST endpoint rejects liveConnectConstraints (HTTP 400 "Unknown name").
// The Live setup must be sent as bidiGenerateContentSetup, with the model as "models/<name>".
describe("ai-teacher: Live token setup shape", () => {
  const tools = [{ functionDeclarations: [{ name: "present_slide", parameters: { type: "OBJECT", properties: {} } }] }];
  const constraints = {
    model: "gemini-3.8-live",
    config: {
      responseModalities: ["AUDIO"],
      systemInstruction: "Teach simply.",
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } },
      tools,
    },
  };

  it("puts model, voice, system instruction and tools in the setup", () => {
    const s = toBidiSetup(constraints);
    assert.equal(s.model, "models/gemini-3.8-live");
    assert.deepEqual(s.generationConfig.responseModalities, ["AUDIO"]);
    assert.equal(s.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, "Kore");
    assert.deepEqual(s.systemInstruction, { parts: [{ text: "Teach simply." }] });
    assert.deepEqual(s.tools, tools);
  });

  it("does not duplicate the model prefix", () => {
    assert.equal(toBidiSetup({ model: "models/gemini-3.8-live", config: {} }).model, "models/gemini-3.8-live");
  });

  it("omits fields that the level does not lock", () => {
    const s = toBidiSetup({ model: "gemini-3.8-live", config: { responseModalities: ["AUDIO"] } });
    assert.deepEqual(s, { model: "models/gemini-3.8-live", generationConfig: { responseModalities: ["AUDIO"] } });
  });
});
