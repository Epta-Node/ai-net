#![no_std]

mod errors;
mod types;

#[cfg(test)]
mod test;

use errors::Error;
use types::{DataKey, Escrow};

use soroban_sdk::{
    contract, contractimpl, symbol_short, token, Address, Env, Map, Symbol, Vec,
};

#[contract]
pub struct PaymentRouter;

#[contractimpl]
impl PaymentRouter {
    pub fn create_task_escrow(
        env: Env,
        task_id: u64,
        coordinator: Address,
        token: Address,
        total_amount: i128,
        amounts: Map<Address, i128>,
        deadline: u64,
    ) -> Result<(), Error> {
        coordinator.require_auth();

        let key = DataKey::Escrow(task_id);
        if env.storage().persistent().has(&key) {
            return Err(Error::AlreadyExists);
        }

        let mut sum = 0;
        for (_, amount) in amounts.iter() {
            sum += amount;
        }

        if sum != total_amount {
            return Err(Error::InsufficientAmount);
        }

        let token_client = token::Client::new(&env, &token);
        token_client.transfer(&coordinator, &env.current_contract_address(), &total_amount);

        let escrow = Escrow {
            coordinator: coordinator.clone(),
            token,
            total_amount,
            amounts,
            deadline,
        };

        env.storage().persistent().set(&key, &escrow);

        env.events().publish(
            (symbol_short!("Escrow"), symbol_short!("Created")),
            (task_id, coordinator, total_amount),
        );

        Ok(())
    }

    pub fn release_to_agent(
        env: Env,
        task_id: u64,
        agents: Vec<Address>,
    ) -> Result<(), Error> {
        let key = DataKey::Escrow(task_id);
        let mut escrow: Escrow = env.storage().persistent().get(&key).ok_or(Error::NotFound)?;

        escrow.coordinator.require_auth();

        if env.ledger().timestamp() > escrow.deadline {
            return Err(Error::Expired);
        }

        let token_client = token::Client::new(&env, &escrow.token);

        for agent in agents.iter() {
            if let Some(amount) = escrow.amounts.get(agent.clone()) {
                if amount > 0 {
                    token_client.transfer(&env.current_contract_address(), &agent, &amount);
                    escrow.amounts.set(agent.clone(), 0);

                    env.events().publish(
                        (symbol_short!("Payment"), symbol_short!("Released")),
                        (task_id, agent, amount),
                    );
                }
            }
        }

        env.storage().persistent().set(&key, &escrow);
        Ok(())
    }

    pub fn refund_coordinator(env: Env, task_id: u64) -> Result<(), Error> {
        let key = DataKey::Escrow(task_id);
        let mut escrow: Escrow = env.storage().persistent().get(&key).ok_or(Error::NotFound)?;

        if env.ledger().timestamp() <= escrow.deadline {
            return Err(Error::NotExpired);
        }

        let token_client = token::Client::new(&env, &escrow.token);

        let mut refunded_amount = 0;
        for (agent, amount) in escrow.amounts.iter() {
            if amount > 0 {
                refunded_amount += amount;
                escrow.amounts.set(agent, 0);
            }
        }

        if refunded_amount > 0 {
            token_client.transfer(&env.current_contract_address(), &escrow.coordinator, &refunded_amount);
        }

        env.storage().persistent().set(&key, &escrow);

        env.events().publish(
            (symbol_short!("Escrow"), symbol_short!("Refunded")),
            (task_id, escrow.coordinator, refunded_amount),
        );

        Ok(())
    }
}
