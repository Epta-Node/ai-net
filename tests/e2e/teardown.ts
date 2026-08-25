import { closeAgentDb } from "../../backend/src/db/agents";
import { closeTaskDb } from "../../backend/src/db/tasks";
import { closeDb } from "../../backend/src/db";
import { clearRegistry } from "../../smart-contracts/src/registry/registry";

module.exports = async () => {
  clearRegistry();
  closeAgentDb();
  closeTaskDb();
  // The payments/registry DB singleton is also held open by route modules;
  // leaving it open aborts the process during jest's forced shutdown.
  closeDb();
};
