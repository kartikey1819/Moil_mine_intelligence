/* Worker thread: runs Monte-Carlo forecast jobs off the HTTP event loop. */
import { parentPort } from 'node:worker_threads';
import { computeMine, clearForecastCache } from '../services/forecast.mjs';
import { loadProductionModel, resetModelCache } from '../ml/production-model.mjs';
import { evaluateScenarioSet } from '../services/optimizer-core.mjs';
import { estimateResources } from '../services/reserves.mjs';
import { trainProductionModel } from '../ml/production-model.mjs';

parentPort.on('message', (msg) => {
  if (msg.broadcast) { if (msg.type === 'reload') { resetModelCache(); clearForecastCache(); } return; }
  try {
    if (msg.modelVersion && loadProductionModel()?.version !== msg.modelVersion) { resetModelCache(); clearForecastCache(); }
    let result;
    if (msg.task === 'mine') result = computeMine(msg.mineId, msg.scenario, { ...msg.opts, live: msg.live });
    else if (msg.task === 'scenarios') result = evaluateScenarioSet(msg.mineId, msg.scenarios, { ...msg.opts, live: msg.live });
    else if (msg.task === 'reserves') result = estimateResources(msg.mineId);
    else if (msg.task === 'train') { const m = trainProductionModel({ log: () => {} }); result = { version: m.version, metrics: m.metrics, training: m.training }; }
    else throw new Error(`unknown task ${msg.task}`);
    parentPort.postMessage({ id: msg.id, result });
  } catch (e) {
    parentPort.postMessage({ id: msg.id, error: String(e.stack || e.message || e) });
  }
});
