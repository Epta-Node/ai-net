use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyExists = 1,
    NotFound = 2,
    Unauthorized = 3,
    Expired = 4,
    NotExpired = 5,
    InsufficientAmount = 6,
    AlreadyPaid = 7,
}
