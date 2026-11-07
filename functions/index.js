"use strict";
// Wiring only: onCall options and the choice of model. All logic lives in lib/handler.js.

const { onCall } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions");
const { defineString } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const cfg = require("./lib/config");
const { handleGenerate } = require("./lib/handler");

initializeApp();

const MQ_VERTEX_LOCATION = defineString("MQ_VERTEX_LOCATION", { default: cfg.DEFAULT_VERTEX_LOCATION });
const IS_EMULATOR = process.env.FUNCTIONS_EMULATOR === "true";
// Mock only inside the Functions emulator AND with an explicit flag. The emulator sets
// FUNCTIONS_EMULATOR; Cloud Run never does.
const USE_MOCK = process.env.FUNCTIONS_EMULATOR === "true" && process.env.MQ_MOCK_MODEL === "1";

let model; // lazy: the real Vertex client is created on first call
function getModel() {
  if (!model) {
    model = USE_MOCK
      ? require("./lib/mock-model").create()
      : require("./lib/model").createVertexModel({ project: process.env.GCLOUD_PROJECT, location: MQ_VERTEX_LOCATION.value() });
  }
  return model;
}

exports.generateGame = onCall({
  region: cfg.FUNCTIONS_REGION,
  timeoutSeconds: 90,
  memory: "512MiB",
  maxInstances: 5,
  concurrency: 8,
  cors: IS_EMULATOR ? true : ["https://genalpha24.github.io"],
  serviceAccount: "mq-game-builder@",
  enforceAppCheck: false,
}, (request) => handleGenerate(request, { db: getFirestore(), model: getModel(), now: () => new Date(), logger }));
