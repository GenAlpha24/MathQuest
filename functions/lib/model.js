"use strict";
// Vertex AI wrapper (Google Gen AI SDK). Both calls use explicit strict safety settings because
// the default for this model family is OFF. Returns a normalized shape the handler relies on.

const { GoogleGenAI, ThinkingLevel, HarmCategory, HarmBlockThreshold } = require("@google/genai");
const cfg = require("./config");

const SAFETY = ["HARM_CATEGORY_HARASSMENT", "HARM_CATEGORY_HATE_SPEECH", "HARM_CATEGORY_SEXUALLY_EXPLICIT", "HARM_CATEGORY_DANGEROUS_CONTENT"]
  .map((c) => ({ category: HarmCategory[c], threshold: HarmBlockThreshold.BLOCK_LOW_AND_ABOVE }));
const BLOCKING_FINISH = ["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "IMAGE_SAFETY"];

function normalize(resp) {
  const cand = resp && resp.candidates && resp.candidates[0];
  const finishReason = cand && cand.finishReason ? String(cand.finishReason) : null;
  const pf = resp && resp.promptFeedback;
  const blockReason = pf && pf.blockReason && pf.blockReason !== "BLOCKED_REASON_UNSPECIFIED" ? String(pf.blockReason) : null;
  let text = "";
  try { text = typeof resp.text === "string" ? resp.text : ""; } catch (e) { text = ""; }
  const um = (resp && resp.usageMetadata) || {};
  return {
    text,
    blocked: !!blockReason || (finishReason !== null && BLOCKING_FINISH.includes(finishReason)),
    blockReason,
    finishReason,
    inTokens: um.promptTokenCount === undefined ? null : um.promptTokenCount,
    outTokens: um.candidatesTokenCount === undefined ? null : um.candidatesTokenCount,
  };
}

function createVertexModel({ project, location }) {
  const ai = new GoogleGenAI({ vertexai: true, project, location, httpOptions: { retryOptions: { attempts: 1 } } });
  async function call(req) {
    const resp = await ai.models.generateContent({
      model: cfg.MODEL_ID,
      contents: [{ role: "user", parts: [{ text: req.userText }] }],
      config: {
        systemInstruction: req.systemInstruction,
        responseMimeType: "application/json",
        responseSchema: req.responseSchema,
        safetySettings: SAFETY,
        maxOutputTokens: req.maxOutputTokens,
        thinkingConfig: { thinkingLevel: ThinkingLevel[req.thinkingLevel] },
        abortSignal: AbortSignal.timeout(req.timeoutMs),
      },
    });
    return normalize(resp);
  }
  return { classify: call, generate: call };
}

module.exports = { createVertexModel, normalize, SAFETY };
