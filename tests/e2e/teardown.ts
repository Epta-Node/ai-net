import { closeAgentDb } from "../../backend/src/db/agents";
import { closeTaskDb } from "../../backend/src/db/tasks";
import { clearRegistry } from "../../smart-contracts/src/registry/registry";

module.exports = async () => {
  clearRegistry();
  closeAgentDb();
  closeTaskDb();
};
