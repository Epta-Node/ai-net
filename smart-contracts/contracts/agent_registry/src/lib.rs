#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Env, Symbol, Vec,
};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentParams {
    pub agent_id: Symbol,
    pub name: Symbol,
    pub price_stroops: i128,
}

#[contracterror]
#[derive(Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotFound = 1,
    Unauthorized = 2,
    AlreadyExists = 3,
    ContractPaused = 4,
    AgentFrozen = 5,
    NotAdmin = 6,
    AlreadyResolved = 7,
    DuplicateInBatch = 8,
    InvalidPrice = 9,
}

#[contract]
pub struct AgentRegistry;

#[contractimpl]
impl AgentRegistry {
    pub fn register_agent(env: Env, record: AgentParams) -> Result<(), Error> {
        if record.price_stroops <= 0 {
            return Err(Error::InvalidPrice);
        }

        let key = symbol_short!("agent");
        let agents: Vec<AgentParams> = env.storage().persistent().get(&key).unwrap_or(Vec::new(&env));

        for agent in agents.iter() {
            if agent.agent_id == record.agent_id {
                return Err(Error::AlreadyExists);
            }
        }

        let mut agents = agents;
        agents.push_back(record);
        env.storage().persistent().set(&key, &agents);
        Ok(())
    }

    pub fn register_agents(env: Env, records: Vec<AgentParams>) -> Result<(), Error> {
        let key = symbol_short!("agent");
        let mut agents: Vec<AgentParams> = env.storage().persistent().get(&key).unwrap_or(Vec::new(&env));

        for record in records.iter() {
            if record.price_stroops <= 0 {
                return Err(Error::InvalidPrice);
            }

            for existing in agents.iter() {
                if existing.agent_id == record.agent_id {
                    return Err(Error::AlreadyExists);
                }
            }

            agents.push_back(record);
        }

        env.storage().persistent().set(&key, &agents);
        Ok(())
    }

    pub fn update_pricing(env: Env, agent_id: Symbol, new_price: i128) -> Result<(), Error> {
        if new_price <= 0 {
            return Err(Error::InvalidPrice);
        }

        let key = symbol_short!("agent");
        let agents: Vec<AgentParams> = env.storage().persistent().get(&key).unwrap_or(Vec::new(&env));

        let mut updated = false;
        let mut new_agents = Vec::new(&env);
        for mut agent in agents.iter() {
            if agent.agent_id == agent_id {
                agent.price_stroops = new_price;
                updated = true;
            }
            new_agents.push_back(agent);
        }

        if !updated {
            return Err(Error::NotFound);
        }

        env.storage().persistent().set(&key, &new_agents);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn register_rejects_zero_price() {
        let env = Env::default();
        let contract_id = env.register(AgentRegistry, ());
        let client = AgentRegistryClient::new(&env, &contract_id);

        let agent = AgentParams {
            agent_id: Symbol::new(&env, "agent_zero"),
            name: Symbol::new(&env, "zero"),
            price_stroops: 0,
        };

        let result = client.try_register_agent(&agent);
        assert_eq!(result, Err(Ok(Error::InvalidPrice)));
    }

    #[test]
    fn register_rejects_negative_price() {
        let env = Env::default();
        let contract_id = env.register(AgentRegistry, ());
        let client = AgentRegistryClient::new(&env, &contract_id);

        let agent = AgentParams {
            agent_id: Symbol::new(&env, "agent_neg"),
            name: Symbol::new(&env, "neg"),
            price_stroops: -100,
        };

        let result = client.try_register_agent(&agent);
        assert_eq!(result, Err(Ok(Error::InvalidPrice)));
    }

    #[test]
    fn update_pricing_rejects_zero_price() {
        let env = Env::default();
        let contract_id = env.register(AgentRegistry, ());
        let client = AgentRegistryClient::new(&env, &contract_id);

        let agent = AgentParams {
            agent_id: Symbol::new(&env, "agnt_upd"),
            name: Symbol::new(&env, "update"),
            price_stroops: 100,
        };
        client.register_agent(&agent);

        let result = client.try_update_pricing(&agent.agent_id, &0i128);
        assert_eq!(result, Err(Ok(Error::InvalidPrice)));
    }

    #[test]
    fn update_pricing_rejects_negative_price() {
        let env = Env::default();
        let contract_id = env.register(AgentRegistry, ());
        let client = AgentRegistryClient::new(&env, &contract_id);

        let agent = AgentParams {
            agent_id: Symbol::new(&env, "agnt_neg_u"),
            name: Symbol::new(&env, "neg_update"),
            price_stroops: 100,
        };
        client.register_agent(&agent);

        let result = client.try_update_pricing(&agent.agent_id, &-50i128);
        assert_eq!(result, Err(Ok(Error::InvalidPrice)));
    }
}
